/* 同步调度：页面负责决定「同步什么、什么时候同步」，后台只负责发请求。
   配置存在 chrome.storage.local，因为后台读不到页面的 localStorage。 */
import { ext, IS_FIREFOX } from './util.js';
import { canonical, sha256Hex } from './hash.js';

const KEY = 'zl.sync';
export const MIN_INTERVAL = 15;

export const DEFAULT_SETTINGS = {
  provider: 'off',
  webdav: { url: '', path: 'zenith/config.json', user: '', pass: '' },
  github: { repo: '', path: 'zenith/config.json', branch: 'main', token: '' },
  intervalMin: 1440,
  auto: true
};

export const DEFAULT_META = {
  lastLocalHash: '',
  lastRemoteEtag: '',
  lastAt: 0,
  lastResult: '',
  failed: false
};

/* 失败后的重试间隔：别让一次网络抖动把自动同步锁死一整天 */
export const FAIL_BACKOFF = 5 * 60 * 1000;

/**
 * 要不要跳过这次同步。纯函数，便于测试。
 * @param {{lastAt:number, failed?:boolean}} meta
 * @param {{intervalMin:number}} settings
 * @param {number} now
 * @param {string} mode  auto / now / push / pull
 */
export function shouldSkip(meta, settings, now, mode) {
  if (mode !== 'auto') return false;
  if (!meta || !meta.lastAt) return false;
  const gap = meta.failed ? FAIL_BACKOFF : Math.max(MIN_INTERVAL, settings.intervalMin || 1440) * 60000;
  return now - meta.lastAt < gap;
}

function hasStorage() {
  return !!(ext && ext.storage && ext.storage.local);
}

export async function loadSettings() {
  if (!hasStorage()) return { ...DEFAULT_SETTINGS };
  const got = await ext.storage.local.get([KEY]);
  return { ...DEFAULT_SETTINGS, ...(got[KEY] || {}) };
}

export async function saveSettings(next) {
  if (!hasStorage()) return;
  const merged = { ...DEFAULT_SETTINGS, ...next };
  merged.intervalMin = Math.max(MIN_INTERVAL, Number(merged.intervalMin) || MIN_INTERVAL);
  await ext.storage.local.set({ [KEY]: merged });
}

export async function loadMeta() {
  if (!hasStorage()) return { ...DEFAULT_META };
  const got = await ext.storage.local.get(['zl.sync.meta']);
  return { ...DEFAULT_META, ...(got['zl.sync.meta'] || {}) };
}

export async function saveMeta(meta) {
  if (!hasStorage()) return;
  await ext.storage.local.set({ 'zl.sync.meta': meta });
}

/* ---------- 与后台通信 ---------- */

function callBackground(msg) {
  return new Promise((resolve) => {
    if (!ext || !ext.runtime) {
      resolve({ ok: false, error: '扩展环境不可用' });
      return;
    }
    const done = (res) => resolve(res || { ok: false, error: '后台无响应' });

    try {
      /* 新版 Chrome 与 Firefox 都返回 Promise；老版本走回调 */
      const ret = ext.runtime.sendMessage(msg);
      if (ret && typeof ret.then === 'function') {
        ret.then(done).catch((e) => resolve({ ok: false, error: (e && e.message) || String(e) }));
      } else {
        done(ret);
      }
    } catch (e) {
      try {
        ext.runtime.sendMessage(msg, (res) => {
          const err = ext.runtime.lastError;
          if (err) resolve({ ok: false, error: err.message || String(err) });
          else done(res);
        });
      } catch (e2) {
        resolve({ ok: false, error: (e2 && e2.message) || String(e2) });
      }
    }
  });
}

/* ---------- 配置快照 ---------- */

const CONFIG_FIELDS = ['theme', 'ui', 'wallpaper', 'engine', 'items', 'widgetData'];

export function configOf(state) {
  const out = { v: state.v, app: 'zenith' };
  for (const k of CONFIG_FIELDS) out[k] = state[k];
  /* 壁纸图片不进同步，只留元信息 */
  if (out.wallpaper) out.wallpaper = { ...out.wallpaper, imageKey: null };
  return out;
}

/* GitHub 不带自定义图标：把 items 里的 icon 字段剥掉。
   WebDAV 保留——带宽够，图标跟着配置走。 */
export function withoutIcons(config) {
  if (!config || !Array.isArray(config.items)) return config;
  return {
    ...config,
    items: config.items.map((it) => {
      if (!it || it.icon === undefined) return it;
      const copy = { ...it };
      delete copy.icon;
      return copy;
    })
  };
}

/* 同步内容：WebDAV 带自定义图标，其它方式不带。
   hashOf 用的还是完整 configOf——图标变了也应该触发一次同步。 */
export function buildSyncText(state, provider) {
  const cfg = configOf(state);
  return JSON.stringify(provider === 'webdav' ? cfg : withoutIcons(cfg), null, 2);
}

export async function hashOf(state) {
  return sha256Hex(canonical(configOf(state)));
}

/* ---------- 应用远端配置 ---------- */

function applyRemote(state, config) {
  /* 远端配置可能不带自定义图标（GitHub 不带）。拉下来时若整个远端
     都没有 icon 字段，把本地已有的按 id 找回去——否则每次 pull
     都会把用户上传的图标抹掉。远端带了 icon（WebDAV）就完全听远端的，
     这样在另一台设备删图标也能正常传播。 */
  let preserveIcons = null;
  const remoteItems = Array.isArray(config.items) ? config.items : [];
  const remoteHasIcons = remoteItems.some((it) => it && it.icon);
  if (!remoteHasIcons && Array.isArray(state.items)) {
    preserveIcons = new Map();
    for (const it of state.items) {
      if (it && it.id && it.icon) preserveIcons.set(it.id, it.icon);
    }
  }

  for (const k of CONFIG_FIELDS) {
    if (config[k] !== undefined) state[k] = config[k];
  }
  state.v = config.v || state.v;

  if (preserveIcons && Array.isArray(state.items)) {
    for (const it of state.items) {
      if (it && it.id && !it.icon && preserveIcons.has(it.id)) it.icon = preserveIcons.get(it.id);
    }
  }
}

/* ---------- 同步主流程 ---------- */

/**
 * @param {'auto'|'now'|'push'|'pull'} mode  now = 手动触发，跳过间隔限制
 * @returns {Promise<{status:string, message?:string}>}
 */
/* 推送，并把 412 处理掉。
   412 意味着 If-Match 用的 etag 已经过期，可能是：
   - 另一个标签页/设备刚好推了一次（我们开多个新标签页都会自动同步）
   - 服务器每次访问都换 etag
   盲目报错会把用户卡死在这里，所以先回拉一次看内容：
   内容一致 → 其实没冲突，用新 etag 记下就行；真的不同 → 交给用户选。 */
/* 两份配置内容是否等价：忽略键顺序和缩进 */
export function sameContent(a, b) {
  try {
    return canonical(JSON.parse(a)) === canonical(JSON.parse(b));
  } catch {
    return false;
  }
}

async function pushGuarded(settings, text, etag, localHash) {
  const res = await callBackground({ type: 'zl:sync', action: 'push', settings, text, etag });
  if (res.ok) return { ok: true, etag: res.etag || etag, pushed: true };
  if (res.status !== 412) return { ok: false, error: res.error || ('HTTP ' + res.status) };

  const again = await callBackground({ type: 'zl:sync', action: 'pull', settings });
  if (!again.ok || !again.exists) {
    return { ok: false, error: '远端已被别处修改，且重新读取失败' };
  }

  if (sameContent(again.data, text)) return { ok: true, etag: again.etag, pushed: false };

  return { ok: false, conflict: true, remoteEtag: again.etag };
}

export async function syncNow(state, { mode = 'auto', persist } = {}) {
  const settings = await loadSettings();
  if (settings.provider === 'off') return { status: 'off' };

  const meta = await loadMeta();

  /* 先判断要不要同步，再算哈希——hashOf 是 canonical + SHA-256 全量配置
     （配置里可能内嵌图标，几百 KB），每个新标签页都跑一次就太浪费了。
     绝大多数打开都命中 skip，应该几乎零开销。 */
  if (mode === 'auto' && settings.auto === false) return { status: 'off' };
  if (shouldSkip(meta, settings, Date.now(), mode)) return { status: 'skip' };

  const localHash = await hashOf(state);
  const localChanged = localHash !== meta.lastLocalHash;

  const remote = await callBackground({ type: 'zl:sync', action: 'pull', settings });
  if (!remote.ok) {
    await saveMeta({ ...meta, lastAt: Date.now(), lastResult: '失败：' + (remote.error || ''), failed: true });
    return { status: 'error', message: remote.error };
  }

  /* 远端还没有文件：直接推一份上去 */
  if (!remote.exists) {
    const text = buildSyncText(state, settings.provider);
    const res = await callBackground({ type: 'zl:sync', action: 'push', settings, text, etag: '' });
    if (!res.ok) {
      await saveMeta({ ...meta, lastAt: Date.now(), lastResult: '失败：' + (res.error || ''), failed: true });
      return { status: 'error', message: res.error };
    }
    await saveMeta({
      lastLocalHash: localHash,
      lastRemoteEtag: res.etag || '',
      lastAt: Date.now(),
      lastResult: res.created ? `已创建 ${res.created} 层目录并上传` : '已上传'
    });
    return {
      status: 'pushed',
      message: res.created ? `已自动创建目录并上传（${res.created} 层）` : '远端没有配置，已上传本地'
    };
  }

  /* 第一次在这台机器上同步：以远端为准，避免把默认布局当成"本地改动" */
  if ((mode === 'auto' || mode === 'now') && !meta.lastAt) {
    applyRemote(state, JSON.parse(remote.data));
    if (persist) persist();
    await saveMeta({
      lastLocalHash: await hashOf(state),
      lastRemoteEtag: remote.etag,
      lastAt: Date.now(),
      lastResult: '首次同步，已拉取'
    });
    return { status: 'pulled', message: '首次同步，已用远端配置' };
  }

  const remoteChanged = remote.etag !== meta.lastRemoteEtag;

  if (mode === 'pull') {
    applyRemote(state, JSON.parse(remote.data));
    if (persist) persist();
    await saveMeta({
      lastLocalHash: await hashOf(state),
      lastRemoteEtag: remote.etag,
      lastAt: Date.now(),
      lastResult: '已拉取'
    });
    return { status: 'pulled', message: '已用远端覆盖本地' };
  }

  if (mode === 'push') {
    const text = buildSyncText(state, settings.provider);
    let res = await callBackground({
      type: 'zl:sync',
      action: 'push',
      settings,
      text,
      etag: remote.etag
    });
    /* 用户明确要求「用本地覆盖远端」，etag 过期不该拦他：重新取一次再推 */
    if (!res.ok && res.status === 412) {
      const again = await callBackground({ type: 'zl:sync', action: 'pull', settings });
      const fresh = again.ok && again.exists ? again.etag : '';
      res = await callBackground({ type: 'zl:sync', action: 'push', settings, text, etag: fresh });
    }
    if (!res.ok) {
      await saveMeta({ ...meta, lastAt: Date.now(), lastResult: '失败：' + (res.error || ''), failed: true });
      return { status: 'error', message: res.error };
    }
    await saveMeta({
      lastLocalHash: localHash,
      lastRemoteEtag: res.etag || remote.etag,
      lastAt: Date.now(),
      lastResult: '已上传'
    });
    return { status: 'pushed', message: '已用本地覆盖远端' };
  }

  /* auto：两边都没变就跳过 */
  if (!localChanged && !remoteChanged) {
    await saveMeta({ ...meta, lastAt: Date.now(), lastResult: '无变化', failed: false });
    return { status: 'noop' };
  }

  /* 只有远端变了：拉下来 */
  if (!localChanged && remoteChanged) {
    applyRemote(state, JSON.parse(remote.data));
    if (persist) persist();
    await saveMeta({
      lastLocalHash: await hashOf(state),
      lastRemoteEtag: remote.etag,
      lastAt: Date.now(),
      lastResult: '已拉取'
    });
    return { status: 'pulled', message: '远端有更新，已同步到本地' };
  }

  /* 只有本地变了：推上去 */
  if (localChanged && !remoteChanged) {
    const text = buildSyncText(state, settings.provider);
    const res = await pushGuarded(settings, text, remote.etag, localHash);
    if (!res.ok && res.conflict) {
      await saveMeta({
        ...meta,
        lastRemoteEtag: res.remoteEtag || remote.etag,
        lastAt: Date.now(),
        lastResult: '冲突',
        failed: false
      });
      return { status: 'conflict', message: '推送时远端被别处改过，需要选择保留哪一份' };
    }
    if (!res.ok) {
      await saveMeta({ ...meta, lastAt: Date.now(), lastResult: '失败：' + (res.error || ''), failed: true });
      return { status: 'error', message: res.error };
    }
    await saveMeta({
      lastLocalHash: localHash,
      lastRemoteEtag: res.etag || remote.etag,
      lastAt: Date.now(),
      lastResult: '已上传'
    });
    return { status: 'pushed', message: '本地有改动，已上传' };
  }

  /* 两边都变了：交给用户决定 */
  await saveMeta({ ...meta, lastAt: Date.now(), lastResult: '冲突', failed: false });
  return { status: 'conflict', message: '本地和远端都改过，需要选择保留哪一份' };
}

export async function testConnection() {
  const settings = await loadSettings();
  if (settings.provider === 'off') return { ok: false, error: '还没选择同步方式' };
  const res = await callBackground({ type: 'zl:sync', action: 'test', settings });
  return res;
}

/* 分别检查「有没有域名权限」和「域名通不通」 */
export async function diagnose() {
  const settings = await loadSettings();
  if (settings.provider === 'off') return null;
  return callBackground({ type: 'zl:diag', settings });
}

/* ---------- 主机权限 ---------- */

/* 注意：permissions.request 必须在用户手势的同一个任务里发起。
   所以这里同步调用 request，中间不能插任何 await——先 contains 再 request
   会让手势失效，浏览器静默返回 false，表现就是「不弹窗、fetch 失败」。 */
export function requestOrigin(url) {
  if (!ext || !ext.permissions) return Promise.resolve({ ok: false, reason: 'no-api' });

  let origin = '';
  try {
    origin = new URL(url).origin + '/*';
  } catch {
    return Promise.resolve({ ok: false, reason: 'bad-url' });
  }

  try {
    const pending = ext.permissions.request({ origins: [origin] });
    return Promise.resolve(pending)
      .then((granted) => ({ ok: !!granted, origin }))
      .catch((e) => ({ ok: false, origin, reason: (e && e.message) || 'request-failed' }));
  } catch (e) {
    return Promise.resolve({ ok: false, origin, reason: (e && e.message) || 'request-threw' });
  }
}

export async function hasOrigin(url) {
  if (!ext || !ext.permissions) return false;
  try {
    const origin = new URL(url).origin + '/*';
    return await ext.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

/* 老版本 Firefox 不支持按需申请域名权限 */
export async function firefoxVersion() {
  if (!IS_FIREFOX || !ext || !ext.runtime || !ext.runtime.getBrowserInfo) return 0;
  try {
    const info = await ext.runtime.getBrowserInfo();
    return parseInt(String(info.version).split('.')[0], 10) || 0;
  } catch {
    return 0;
  }
}
