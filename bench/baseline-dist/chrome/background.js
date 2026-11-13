/* 后台：唯一允许出网的地方。
   - Chromium：MV3 service worker（经典 worker，用 importScripts 载入 sync-core）
   - Firefox：事件页，manifest 里按顺序加载 sync-core.js + background.js
   另外在 Firefox 上负责抓标签页图标（Chromium 走 _favicon，不需要）。 */

if (typeof importScripts === 'function') {
  try {
    importScripts('/sync-core.js');
  } catch (e) {
    console.error('[zenith] 载入 sync-core 失败', e);
  }
}

const ext = globalThis.browser || globalThis.chrome;
const ZL = globalThis.ZLSync;

/* ---------- 同步请求 ---------- */

/* 把「哪条 URL、什么凭据」抽出来，方便做权限与连通性检查 */
function credsFor(settings) {
  if (!ZL) return null;
  if (settings.provider === 'webdav' && settings.webdav) {
    const c = settings.webdav;
    return {
      url: c.url || '',
      fileUrl: ZL.joinUrl(c.url || '', c.path || 'zenith/config.json'),
      headers: c.user ? { Authorization: ZL.basicAuth(c.user, c.pass) } : {}
    };
  }
  if (settings.provider === 'github' && settings.github) {
    const c = settings.github;
    return {
      url: 'https://api.github.com',
      fileUrl: 'https://api.github.com',
      headers: c.token ? { Authorization: 'Bearer ' + c.token } : {}
    };
  }
  return null;
}

async function preflight(settings) {
  const c = credsFor(settings);
  if (!c) return { ok: false, error: '未配置同步方式' };

  const origin = ZL.originOf(c.url);
  let granted = false;
  try {
    granted = await ext.permissions.contains({ origins: [origin] });
  } catch {
    granted = false;
  }
  return { ok: true, url: c.url, fileUrl: c.fileUrl, origin, granted, headers: c.headers };
}

/* 诊断：分别回答「有没有权限」和「域名通不通」 */
async function diagnose(settings) {
  const pre = await preflight(settings);
  if (!pre.ok) return pre;

  const out = {
    provider: settings.provider,
    origin: pre.origin,
    url: pre.url,
    granted: pre.granted,
    reachable: null,
    status: 0,
    ms: 0,
    error: ''
  };

  if (!pre.granted) return out;

  const result = await ZL.probe(pre.url, pre.headers);
  out.reachable = result.reachable;
  out.status = result.status || 0;
  out.ms = result.ms || 0;
  out.error = result.error || '';
  return out;
}

async function handleSync(msg) {
  if (!ZL) return { ok: false, error: '内核未载入' };
  const settings = msg.settings || {};
  const provider = ZL.providerOf(settings);
  if (!provider) return { ok: false, error: '未配置同步方式' };

  const pre = await preflight(settings);
  if (pre.ok && !pre.granted) {
    return {
      ok: false,
      code: 'no-permission',
      error: `没有 ${pre.origin} 的访问权限，请重新点「保存并授权」`
    };
  }

  try {
    if (msg.action === 'pull') return await provider.pull();
    if (msg.action === 'push') return await provider.push(msg.text, msg.etag);
    if (msg.action === 'test') {
      const res = await provider.pull();
      if (res.ok) return { ok: true, exists: !!res.exists };
      return res;
    }
    return { ok: false, error: '未知动作' };
  } catch (e) {
    const msg2 = (e && e.message) || '请求失败';
    /* fetch 在缺主机权限、证书错误、DNS 失败时都只给一句 Failed to fetch，
       带上目标地址，方便直接判断是哪一层出的问题 */
    if (/failed to fetch|networkerror|network error|load failed/i.test(msg2)) {
      return {
        ok: false,
        code: 'network',
        error: `连不上 ${pre.ok ? pre.fileUrl : ''}（可能是证书、DNS 或代理问题）`
      };
    }
    return { ok: false, error: msg2 };
  }
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return undefined;

  if (msg.type === 'zl:sync') {
    handleSync(msg).then(sendResponse);
    return true; // 异步回应
  }

  if (msg.type === 'zl:diag') {
    diagnose(msg.settings || {})
      .then(sendResponse)
      .catch((e) => sendResponse({ granted: false, reachable: false, error: (e && e.message) || '' }));
    return true;
  }

  if (msg.type === 'zl:scan-tabs') {
    scanTabs().then(sendResponse);
    return true;
  }

  return undefined;
});

/* ---------- Firefox 图标抓取 ---------- */

const MAX_BYTES = 256 * 1024;
const DATA_URI_RE =
  /^data:(image\/(?:png|jpe?g|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon));base64,([A-Za-z0-9+/=\s]+)$/i;

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function hashBytes(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

/* 部分站点的 SVG 没有 viewBox，塞进固定尺寸的 <img> 会缩放异常 */
function ensureSvgViewBox(text) {
  if (/viewBox\s*=/i.test(text)) return text;
  const w = /width\s*=\s*["']?([\d.]+)/i.exec(text);
  const h = /height\s*=\s*["']?([\d.]+)/i.exec(text);
  if (!w || !h) return text;
  return text.replace(/<svg\b/i, '<svg viewBox="0 0 ' + w[1] + ' ' + h[1] + '"');
}

function decodeIcon(uri) {
  const m = DATA_URI_RE.exec(String(uri).trim());
  if (!m) return null;

  const mime = m[1].toLowerCase();
  const b64 = m[2].replace(/\s+/g, '');
  const pad = b64.slice(-2) === '==' ? 2 : b64.slice(-1) === '=' ? 1 : 0;
  const size = Math.floor((b64.length * 3) / 4) - pad;
  if (size <= 0 || size > MAX_BYTES) return null;

  let bin;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }

  let bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  if (mime.indexOf('svg') !== -1) {
    try {
      const text = new TextDecoder().decode(bytes);
      const fixed = ensureSvgViewBox(text);
      if (fixed !== text) bytes = new TextEncoder().encode(fixed);
    } catch {
      /* 用原样数据 */
    }
  }

  return { mime, bytes };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('zl', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('icons')) db.createObjectStore('icons');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function iconGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('icons', 'readonly');
    const r = t.objectStore('icons').get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function iconPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('icons', 'readwrite');
    t.objectStore('icons').put(value, key);
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}

async function capture(tab) {
  if (!tab || !tab.url || !tab.favIconUrl) return false;
  const host = hostOf(tab.url);
  if (!host) return false;

  const parsed = decodeIcon(tab.favIconUrl);
  if (!parsed) return false;

  const hash = hashBytes(parsed.bytes);
  try {
    const prev = await iconGet(host);
    if (prev && prev.hash === hash && prev.ts && Date.now() - prev.ts < 30 * 24 * 3600 * 1000) {
      return false;
    }
  } catch {
    /* 读不到就当作首次 */
  }

  await iconPut(host, {
    blob: new Blob([parsed.bytes], { type: parsed.mime }),
    mime: parsed.mime,
    ts: Date.now(),
    hash
  });
  return true;
}

async function scanTabs() {
  if (!ext.tabs || !ext.permissions) return { ok: false, count: 0, reason: 'no-api' };

  let granted = false;
  try {
    granted = await ext.permissions.contains({ permissions: ['tabs'] });
  } catch {
    granted = false;
  }
  if (!granted) return { ok: false, count: 0, reason: 'no-permission' };

  const tabs = await ext.tabs.query({});
  let saved = 0;
  for (const tab of tabs) {
    try {
      if (await capture(tab)) saved++;
    } catch {
      /* 单个失败不影响整轮 */
    }
  }
  return { ok: true, count: tabs.length, saved };
}

/* Chromium 没有 favIconUrl 的 data URI，这段只在 Firefox 生效 */
try {
  if (ext.tabs && ext.tabs.onUpdated) {
    ext.tabs.onUpdated.addListener(
      (tabId, changeInfo, tab) => {
        if (changeInfo && changeInfo.favIconUrl) capture(tab);
      },
      { properties: ['favIconUrl'] }
    );
  }
} catch {
  /* 权限不足时注册失败，忽略 */
}

/* ---------- 工具栏按钮 ---------- */

/* 点图标打开起始页。tabs.create 不需要 tabs 权限，所以这里不申请任何新权限 */
try {
  if (ext.action && ext.action.onClicked) {
    ext.action.onClicked.addListener(() => {
      ext.tabs.create({ url: ext.runtime.getURL('newtab.html') });
    });
  }
} catch {
  /* 旧版本没有 action API，忽略 */
}

