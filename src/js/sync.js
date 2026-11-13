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
  failed: false,
  /* 上一次「覆盖本地」到底改了什么，结构化存下来给设置面板解释 */
  lastChanges: null
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

const CONFIG_FIELDS = ['theme', 'ui', 'wallpaper', 'engine', 'items', 'widgetData', 'widgetConfig'];

/* 本地关掉同步的组件类型集合；没有关闭任何类型时返回 null（零开销路径） */
export function excludedTypes(state) {
  const m = state && state.syncByType;
  if (!m) return null;
  let set = null;
  for (const k in m) {
    if (m[k] === false) (set || (set = new Set())).add(k);
  }
  return set;
}

function typeOfItems(state) {
  const map = new Map();
  for (const it of (state && state.items) || []) {
    if (it && it.kind === 'widget') map.set(it.id, it.type);
  }
  return map;
}

/* 按开关过滤 widgetData：没有任何排除项时原样返回（不复制） */
export function filterWidgetData(state, widgetData) {
  const ex = excludedTypes(state);
  if (!ex || !widgetData || typeof widgetData !== 'object') return widgetData;
  const typeOf = typeOfItems(state);
  let out = null;
  for (const id in widgetData) {
    const t = typeOf.get(id);
    if (t && ex.has(t)) {
      if (!out) {
        out = {};
        for (const k in widgetData) {
          if (k === id) break;
          out[k] = widgetData[k];
        }
      }
      continue;
    }
    if (out) out[id] = widgetData[id];
  }
  return out || widgetData;
}

export function configOf(state) {
  const out = { v: state.v, app: 'zenith' };
  for (const k of CONFIG_FIELDS) out[k] = state[k];
  /* 壁纸图片不进同步，只留元信息；slides 是本机图片键清单，对面没有对应图片，
     传过去只会得到一批指向空文件的轮播项，必须剔除。 */
  if (out.wallpaper) {
    out.wallpaper = { ...out.wallpaper, imageKey: null };
    delete out.wallpaper.slides;
  }
  return out;
}

/* 同步用的快照：在 configOf 之上再按开关剔除组件数据。
   手动导出（pack.js）走 configOf，永远导出完整数据；
   只有同步内容按每台设备自己的开关裁剪。 */
export function syncConfigOf(state) {
  const out = configOf(state);
  out.widgetData = filterWidgetData(state, out.widgetData);
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
   hash 用同步口径的快照——被排除的组件改动不应触发同步。

   noIcons 是「这份配置是否刻意剔除了图标」的显式声明。没有它，
   applyRemote 只能靠「远端 items 里有没有 icon」猜：用户删掉最后一个
   自定义图标时会被误判成 GitHub 同步，图标又被从本地找回、删除无法传播。
   老版本写下的远端没有这个字段，继续用启发式兼容。 */
export function buildSyncText(state, provider) {
  const cfg = syncConfigOf(state);
  if (provider === 'webdav') return JSON.stringify({ ...cfg, noIcons: false }, null, 2);
  return JSON.stringify({ ...withoutIcons(cfg), noIcons: true }, null, 2);
}

export async function hashOf(state) {
  return sha256Hex(canonical(syncConfigOf(state)));
}

/* ---------- 应用远端配置 ---------- */

function applyRemote(state, config) {
  /* 远端配置可能不带自定义图标（GitHub 不带）。这时把本地已有的按 id
     找回去，否则每次 pull 都会把用户上传的图标抹掉。
     新版本用 noIcons 显式声明；旧配置没有该字段时才退回「整份都没有
     icon 就当作被剥过」的启发式。WebDAV 的 noIcons:false 表示图标语义完整，
     删掉最后一个图标也能正常传播到另一台设备。 */
  let preserveIcons = null;
  const remoteItems = Array.isArray(config.items) ? config.items : [];
  const remoteHasIcons = remoteItems.some((it) => it && it.icon);
  const iconsStripped = config.noIcons === true ||
    (config.noIcons === undefined && !remoteHasIcons);
  if (iconsStripped && Array.isArray(state.items)) {
    preserveIcons = new Map();
    for (const it of state.items) {
      if (it && it.id && it.icon) preserveIcons.set(it.id, it.icon);
    }
  }

  /* 本地关掉同步的组件数据不被远端覆盖（远端本来就不该有它，
     但另一台设备可能没关，把它推上来了） */
  const ex = excludedTypes(state);
  let keepLocal = null;
  if (ex && state.widgetData && typeof state.widgetData === 'object') {
    const typeOf = typeOfItems(state);
    for (const id in state.widgetData) {
      const t = typeOf.get(id);
      if (t && ex.has(t)) (keepLocal || (keepLocal = {}))[id] = state.widgetData[id];
    }
  }

  /* wallpaper 单独处理：远端的配置里没有 slides（configOf 剔除了），
     直接覆盖会把本机的轮播清单抹掉，而图片本来也只存在这台机器上。 */
  const localSlides = state.wallpaper && state.wallpaper.slides;
  for (const k of CONFIG_FIELDS) {
    if (k === 'wallpaper') continue;
    if (config[k] !== undefined) state[k] = config[k];
  }
  if (config.wallpaper !== undefined) state.wallpaper = config.wallpaper;
  if (Array.isArray(localSlides) && state.wallpaper) state.wallpaper.slides = localSlides;
  state.v = config.v || state.v;

  if (keepLocal) {
    state.widgetData = { ...(state.widgetData || {}), ...keepLocal };
  }

  if (preserveIcons && Array.isArray(state.items)) {
    for (const it of state.items) {
      if (it && it.id && !it.icon && preserveIcons.has(it.id)) it.icon = preserveIcons.get(it.id);
    }
  }
}

/* 覆盖本地前的统一入口：留快照（由页面注入，sync.js 不依赖 IndexedDB），
   再算出这次到底改了什么。快照失败不能阻断同步，所以吞掉异常。 */
async function pullInto(state, data, hooks) {
  const before = syncConfigOf(state);
  if (hooks && typeof hooks.onBeforeOverwrite === 'function') {
    try {
      await hooks.onBeforeOverwrite();
    } catch { /* 存储不可用时仍然继续同步 */ }
  }
  applyRemote(state, JSON.parse(data));
  /* 差异比较只在真的要覆盖时用到，不进首屏静态链路 */
  const { diffConfigs } = await import('./diff.js');
  return diffConfigs(before, syncConfigOf(state));
}

/* 只读预览：拉一次远端，算出「如果现在同步会改什么」，不写任何状态。 */
export async function previewSync(state) {
  const settings = await loadSettings();
  if (settings.provider === 'off') return { ok: false, reason: 'off' };
  const remote = await callBackground({ type: 'zl:sync', action: 'pull', settings });
  if (!remote.ok) return { ok: false, error: remote.error || 'pull-failed' };
  if (!remote.exists) return { ok: true, empty: true, diff: null };
  let cfg;
  try {
    cfg = JSON.parse(remote.data);
  } catch {
    return { ok: false, error: 'bad-json' };
  }
  const { diffConfigs } = await import('./diff.js');
  return { ok: true, empty: false, diff: diffConfigs(syncConfigOf(state), cfg) };
}

/* 冲突时给用户看「远端和本地到底差在哪」，只读、不写任何状态。
   远端文本可能来自旧版本或坏死数据，解析失败就返回 null，不阻断裁决。 */
async function conflictDiff(state, remoteData) {
  if (!remoteData) return null;
  try {
    const { diffConfigs } = await import('./diff.js');
    return diffConfigs(syncConfigOf(state), JSON.parse(remoteData));
  } catch {
    return null;
  }
}

/* ---------- 同步主流程 ---------- */

/**
 * @param {'auto'|'now'|'push'|'pull'} mode  now = 手动触发，跳过间隔限制
 * @param {boolean} skipBackup  覆盖本地时不留快照：新设备初始化时本地只是默认布局，
 *                              存一份没有回滚价值，还要白占一个快照名额
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

  return { ok: false, conflict: true, remoteEtag: again.etag, remoteData: again.data };
}

export async function syncNow(state, { mode = 'auto', persist, onBeforeOverwrite, skipBackup = false } = {}) {
  const settings = await loadSettings();
  if (settings.provider === 'off') return { status: 'off' };

  /* 只对「这一次调用」生效：自动同步和常驻的拉取按钮照旧留快照，
     只有用户明确选了「不备份直接覆盖」才把钩子摘掉。 */
  const hooks = skipBackup ? undefined : { onBeforeOverwrite };

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
    const diff = await pullInto(state, remote.data, hooks);
    if (persist) persist();
    await saveMeta({
      lastLocalHash: await hashOf(state),
      lastRemoteEtag: remote.etag,
      lastAt: Date.now(),
      lastResult: '首次同步，已拉取',
      lastChanges: diff
    });
    return { status: 'pulled', backup: !skipBackup, message: '首次同步，已用远端配置' };
  }

  const remoteChanged = remote.etag !== meta.lastRemoteEtag;

  if (mode === 'pull') {
    const diff = await pullInto(state, remote.data, hooks);
    if (persist) persist();
    await saveMeta({
      lastLocalHash: await hashOf(state),
      lastRemoteEtag: remote.etag,
      lastAt: Date.now(),
      lastResult: '已拉取',
      lastChanges: diff
    });
    return { status: 'pulled', backup: !skipBackup, message: '已用远端覆盖本地' };
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
    const diff = await pullInto(state, remote.data, hooks);
    if (persist) persist();
    await saveMeta({
      lastLocalHash: await hashOf(state),
      lastRemoteEtag: remote.etag,
      lastAt: Date.now(),
      lastResult: '已拉取',
      lastChanges: diff
    });
    return { status: 'pulled', backup: !skipBackup, message: '远端有更新，已同步到本地' };
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
      return {
        status: 'conflict',
        message: '推送时远端被别处改过，需要选择保留哪一份',
        diff: await conflictDiff(state, res.remoteData)
      };
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
  return {
    status: 'conflict',
    message: '本地和远端都改过，需要选择保留哪一份',
    diff: await conflictDiff(state, remote.data)
  };
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
