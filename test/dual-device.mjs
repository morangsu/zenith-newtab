/* 虚拟双设备同步测试：两台「设备」各有自己的 state / settings / sync meta，
 * 共享一个本地假 WebDAV（真实 HTTP + ETag + If-Match 412）。
 * 用的是页面侧真实的 sync.js 与后台侧真实的 sync-core.js，只有
 * chrome.runtime.sendMessage 被换成桩，因此 412、哈希、过滤、应用远端
 * 都走生产代码路径，而不是把结论写死在断言里。
 *
 *   node test/dual-device.mjs
 *
 * 覆盖：首次收敛 / 单向编辑传播 / 组件级排除 / 自定义图标双向语义 /
 *       412 自愈与真冲突 / 覆盖前快照 + 回滚后再次同步收敛 /
 *       wallpaper.slides 不跨设备 / 手动导出永远完整。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
vm.runInThisContext(readFileSync(join(ROOT, 'src', 'sync-core.js'), 'utf8'), {
  filename: 'sync-core.js'
});
const ZL = globalThis.ZLSync;

let pass = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) pass++;
  else failures.push(name + (extra ? '  → ' + extra : ''));
};
const eq = (name, a, b) => ok(name, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);

/* ---------- 内存 IndexedDB 桩（与 features.mjs 同一套，够 idb.js 用） ---------- */

function makeFakeIdb() {
  const stores = new Map();
  const ensure = (n) => {
    if (!stores.has(n)) stores.set(n, new Map());
    return stores.get(n);
  };
  const db = {
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore: (n) => { ensure(n); return {}; },
    transaction(name) {
      const map = ensure(name);
      const os = {
        get(k) { return { result: map.get(k), onsuccess: null }; },
        put(v, k) { map.set(k, v); return { result: k }; },
        delete(k) { map.delete(k); return { result: undefined }; },
        clear() { map.clear(); return {}; },
        openCursor() {
          const entries = [...map.entries()];
          let i = 0;
          const req = { result: null, onsuccess: null };
          const next = () => {
            if (i < entries.length) {
              const [key, value] = entries[i++];
              req.result = { key, value, continue: next };
            } else req.result = null;
            if (req.onsuccess) req.onsuccess();
          };
          queueMicrotask(next);
          return req;
        }
      };
      const t = { objectStore: () => os, oncomplete: null, onerror: null, onabort: null, error: null };
      queueMicrotask(() => { if (t.oncomplete) t.oncomplete(); });
      return t;
    }
  };
  globalThis.indexedDB = {
    open() {
      const req = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, error: null };
      queueMicrotask(() => {
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    }
  };
  return stores;
}
makeFakeIdb();
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear()
};
globalThis.window = globalThis;

/* ---------- 假 WebDAV：两台设备共享同一份远端 ---------- */

const PATH = '/dav/zenith/config.json';
const files = new Map();
const dirs = new Set(['/dav']);
let counter = 0;
const requests = [];
const parentOf = (url) => url.replace(/\/[^/]*$/, '') || '/';

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  requests.push(req.method + ' ' + url);

  if (req.method === 'MKCOL') {
    if (!dirs.has(parentOf(url))) { res.writeHead(409); res.end('parent missing'); return; }
    dirs.add(url);
    res.writeHead(201); res.end(); return;
  }
  if (req.method === 'PROPFIND') {
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>' +
      url + '</d:href><d:propstat><d:prop><d:resourcetype></d:resourcetype>' +
      '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>');
    return;
  }
  if (req.method === 'PUT') {
    if (!dirs.has(parentOf(url))) { res.writeHead(409); res.end('parent missing'); return; }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const prev = files.get(url);
      const ifMatch = req.headers['if-match'];
      if (ifMatch && prev && ifMatch !== `"${prev.etag}"`) {
        res.writeHead(412); res.end('precondition failed'); return;
      }
      const etag = 'e' + ++counter;
      files.set(url, { body, etag });
      res.writeHead(201, { ETag: `"${etag}"` }); res.end();
    });
    return;
  }
  if (req.method === 'GET') {
    const hit = files.get(url);
    if (!hit) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { ETag: `"${hit.etag}"`, 'Content-Type': 'application/json' });
    res.end(hit.body);
    return;
  }
  res.writeHead(405); res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const WEBDAV = { url: `http://127.0.0.1:${server.address().port}/dav`, path: 'zenith/config.json', user: 'u', pass: 'p' };

/* 下一次 pull 假装返回一个过期 etag，用于制造真实的 412 竞态。
 * 只消费一次：pushGuarded 的「回拉复核」拿到的仍是服务器真实 etag。 */
let forcedPullEtag = null;

/* ---------- 扩展 API 桩：current 决定现在是哪台设备 ---------- */

let current = null;

globalThis.chrome = {
  storage: {
    local: {
      get(keys) {
        const arr = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of arr) if (current.kv.has(k)) out[k] = current.kv.get(k);
        return Promise.resolve(out);
      },
      set(obj) {
        for (const [k, v] of Object.entries(obj)) current.kv.set(k, JSON.parse(JSON.stringify(v)));
        return Promise.resolve();
      }
    }
  },
  runtime: {
    /* 等价于 background.js 的 handleSync；底层统一走假 WebDAV，
       provider 只影响页面侧 buildSyncText 是否剥图标 */
    sendMessage(msg) {
      if (msg.type !== 'zl:sync') return Promise.resolve({ ok: false, error: 'unknown message' });
      const provider = ZL.providerOf({ provider: 'webdav', webdav: WEBDAV });
      if (msg.action === 'test') return provider.pull().then((r) => ({ ok: r.ok, exists: !!r.exists }));
      if (msg.action === 'pull') {
        return provider.pull().then((r) => {
          if (r.ok && forcedPullEtag) {
            const etag = forcedPullEtag;
            forcedPullEtag = null;
            return { ...r, etag };
          }
          return r;
        });
      }
      if (msg.action === 'push') return provider.push(msg.text, msg.etag);
      return Promise.resolve({ ok: false, error: '未知动作' });
    }
  }
};

/* ext 在 util.js 里是模块加载时求值的常量，必须先装好桩再 import */
const {
  DEFAULT_SETTINGS, DEFAULT_META, syncNow, hashOf, buildSyncText, configOf,
  syncConfigOf, withoutIcons, sameContent, shouldSkip
} = await import('../src/js/sync.js');
const { defaultState } = await import('../src/js/store.js');
const { buildPack } = await import('../src/js/pack.js');
const {
  takeSnapshot, listSnapshots, readSnapshot, restoreSnapshot, clearSnapshots, SNAP_FIELDS
} = await import('../src/js/snapshots.js');

function device(id, provider = 'webdav') {
  const d = { id, kv: new Map(), state: defaultState(), persists: 0, hooks: 0 };
  d.kv.set('zl.sync', {
    ...DEFAULT_SETTINGS,
    provider,
    webdav: { ...WEBDAV },
    github: { repo: 'u/r', path: 'zenith/config.json', branch: 'main', token: '' }
  });
  return d;
}
const metaOf = (d) => ({ ...DEFAULT_META, ...(d.kv.get('zl.sync.meta') || {}) });
const setMeta = (d, patch) => d.kv.set('zl.sync.meta', { ...metaOf(d), ...patch });
const setProvider = (d, p) => d.kv.set('zl.sync', { ...d.kv.get('zl.sync'), provider: p });

async function onDevice(d, fn) {
  current = d;
  try { return await fn(); } finally { current = null; }
}
async function sync(d, mode = 'now') {
  return onDevice(d, () => syncNow(d.state, {
    mode,
    persist: () => { d.persists++; },
    onBeforeOverwrite: async () => { d.hooks++; await takeSnapshot(d.state, 'sync'); }
  }));
}

const A = device('A');
const B = device('B');

/* ============ 1. 首次收敛：A 建远端，B 以远端为准 ============ */

/* 故意让 B 的初始状态和 A 不同，才能验证「首次以远端为准」和差异摘要 */
B.state.engine = 'google';
B.state.items.push({ id: 'b-only', kind: 'link', title: 'Only B', url: 'https://b.example/', cols: 1, rows: 1 });

let r = await sync(A);
eq('A 首次同步：远端为空→上传', r.status, 'pushed');
ok('远端文件已建立', files.has(PATH));
eq('A 记录了最后上传的 etag', metaOf(A).lastRemoteEtag, files.get(PATH).etag);

r = await sync(B);
eq('B 首次同步：以远端为准', r.status, 'pulled');
eq('B 的引擎被远端覆盖', B.state.engine, defaultState().engine);
ok('B 独有的站点被移除', !B.state.items.some((it) => it.id === 'b-only'));
eq('覆盖后两端状态哈希一致', await hashOf(B.state), await hashOf(A.state));
ok('B 记录了结构化的变化摘要', !!metaOf(B).lastChanges && !metaOf(B).lastChanges.empty,
  JSON.stringify(metaOf(B).lastChanges));
ok('覆盖前调用了 persist', B.persists >= 1);
ok('覆盖前调用了快照钩子', B.hooks >= 1);

/* ============ 2. 单向编辑传播 + 无变化 noop ============ */

A.state.items.push({ id: 'new-a', kind: 'link', title: 'New', url: 'https://new.example/', cols: 1, rows: 1 });
r = await sync(A);
eq('A 本地改动→上传', r.status, 'pushed');
r = await sync(B);
eq('B 检测到远端变化→拉取', r.status, 'pulled');
ok('新站点传播到 B', B.state.items.some((it) => it.id === 'new-a'));
eq('再次同步 A 无变化', (await sync(A)).status, 'noop');
eq('再次同步 B 无变化', (await sync(B)).status, 'noop');
eq('shouldSkip：auto 在间隔内跳过', shouldSkip({ lastAt: 1000 }, { intervalMin: 15 }, 1000 + 60000, 'auto'), true);
eq('shouldSkip：手动触发不跳过', shouldSkip({ lastAt: 1000 }, { intervalMin: 15 }, 1000, 'now'), false);

/* ============ 3. 组件级排除：不上传、不触发哈希、不被覆盖 ============ */

A.state.syncByType = { todo: false };
const hashBeforeTodo = await hashOf(A.state);
A.state.widgetData['w-todo'] = { text: '这台设备私密的清单' };
eq('被排除组件的改动不改变同步哈希', await hashOf(A.state), hashBeforeTodo);
ok('同步文本不含被排除组件的数据', !buildSyncText(A.state, 'webdav').includes('这台设备私密的清单'));
ok('手动导出仍包含被排除组件的数据', (await buildPack(A.state)).text.includes('这台设备私密的清单'));
ok('configOf 含全部 widgetData', configOf(A.state).widgetData['w-todo'].text === '这台设备私密的清单');
ok('syncConfigOf 剔除被排除组件', !('w-todo' in syncConfigOf(A.state).widgetData));

A.state.engine = 'duckduckgo';
eq('A 强制推送（含其它改动）', (await sync(A, 'push')).status, 'pushed');
B.state.syncByType = { todo: false };
B.state.widgetData['w-todo'] = { text: 'B 自己的清单' };
r = await sync(B);
eq('B 拉取远端', r.status, 'pulled');
eq('B 本地被排除组件数据未被覆盖', B.state.widgetData['w-todo'].text, 'B 自己的清单');
eq('B 的引擎跟随远端', B.state.engine, 'duckduckgo');

/* ============ 4. 本机壁纸轮播清单不跨设备 ============ */

A.state.wallpaper.slides = [{ key: 'a-slide' }];
B.state.wallpaper.slides = [{ key: 'b-slide' }];
eq('configOf 不带 slides', configOf(A.state).wallpaper.slides, undefined);
ok('同步文本不含本机轮播键', !buildSyncText(A.state, 'webdav').includes('a-slide'));
eq('同步文本里 imageKey 被置空', JSON.parse(buildSyncText(A.state, 'webdav')).wallpaper.imageKey, null);
eq('A 推送轮播相关改动', (await sync(A, 'push')).status, 'pushed');
await sync(B);
eq('B 的轮播清单仍是自己的', B.state.wallpaper.slides[0].key, 'b-slide');

/* ============ 5. 自定义图标：WebDAV 带、GitHub 不带、本地不被抹掉 ============ */

const ICON = 'data:image/png;base64,iVBORw0KGgoAAA';
A.state.items.find((it) => it.id === 'seed-0').icon = ICON;
ok('WebDAV 同步文本带图标', buildSyncText(A.state, 'webdav').includes(ICON));
ok('GitHub 同步文本不带图标', !buildSyncText(A.state, 'github').includes(ICON));
ok('withoutIcons 不动其它字段', withoutIcons(configOf(A.state)).items.find((it) => it.id === 'seed-0').title ===
  A.state.items.find((it) => it.id === 'seed-0').title);
eq('A 推送带图标的配置', (await sync(A, 'push')).status, 'pushed');
await sync(B);
eq('B 收到 WebDAV 传来的图标', B.state.items.find((it) => it.id === 'seed-0').icon, ICON);

/* 换 GitHub 推：远端不带任何图标，B 本地图标必须保留 */
setProvider(A, 'github');
eq('GitHub 推送成功', (await sync(A, 'push')).status, 'pushed');
ok('远端确实不含图标数据', !files.get(PATH).body.includes(ICON));
await sync(B);
eq('远端无图标时保留 B 的本地图标', B.state.items.find((it) => it.id === 'seed-0').icon, ICON);
setProvider(A, 'webdav');

/* 显式删除图标必须能传播：与上面「GitHub 剥图标」要能区分开 */
delete A.state.items.find((it) => it.id === 'seed-0').icon;
eq('A 推送删除图标', (await sync(A, 'push')).status, 'pushed');
await sync(B);
eq('WebDAV 显式删除图标能传播到 B', B.state.items.find((it) => it.id === 'seed-0').icon, undefined);

/* ============ 6. 412 自愈与真冲突（真 If-Match 竞态） ============ */

/* 让 B 把一份内容推上远端，拿到新 etag；A 手里仍是旧 etag，
 * 且第一次 pull 被伪装成旧 etag → A 认为「远端没变」并带旧 etag 推 → 412。 */
const oldEtag = metaOf(A).lastRemoteEtag;
A.state.ui.scale = 1.42;
const sameText = buildSyncText(A.state, 'webdav');
B.state.ui.scale = 1.42;
B.state.wallpaper.slides = [{ key: 'b-slide' }];
B.state.syncByType = { todo: false };
B.state.widgetData['w-todo'] = { text: 'B 自己的清单' };
/* B 的同步口径必须与 A 一致，才构成「内容相同的 412」 */
const bText = buildSyncText(B.state, 'webdav');
eq('两端待推内容一致（前提成立）', sameText, bText);
eq('B 抢先推送', (await sync(B, 'push')).status, 'pushed');
const freshEtag = files.get(PATH).etag;
ok('远端 etag 已推进', freshEtag !== oldEtag);

setMeta(A, { lastRemoteEtag: oldEtag, lastLocalHash: 'stale-hash', lastAt: Date.now() });
forcedPullEtag = oldEtag;
r = await sync(A);
eq('内容一致的 412 自愈为成功', r.status, 'pushed');
ok('412 自愈没有误报冲突', r.status !== 'conflict', JSON.stringify(r));
eq('自愈后 meta 记录新 etag', metaOf(A).lastRemoteEtag, freshEtag);
eq('sameContent 忽略键顺序与缩进', sameContent('{"b":2,"a":1}', '{\n  "a": 1,\n  "b": 2\n}'), true);

/* 真冲突：远端内容确实和 A 要推的不一样 */
A.state.ui.scale = 1.99;
const conflictOldEtag = metaOf(A).lastRemoteEtag;
B.state.ui.scale = 1.11;
eq('B 再次抢先推送不同内容', (await sync(B, 'push')).status, 'pushed');
setMeta(A, { lastRemoteEtag: conflictOldEtag, lastLocalHash: 'stale-hash-2', lastAt: Date.now() });
forcedPullEtag = conflictOldEtag;
r = await sync(A);
eq('内容不同的 412 判定为冲突', r.status, 'conflict');
eq('冲突不覆盖本地状态', A.state.ui.scale, 1.99);
ok('失败 meta 未标记为网络错误', metaOf(A).failed !== true);

/* ============ 7. 覆盖前快照、回滚、回滚后再次同步收敛 ============ */

await clearSnapshots();
/* B 先推一份自己的状态，把 lastLocalHash 刷新到当前值；
   否则下一轮 A 覆盖了远端时，B 会被判成「两边都改过」的冲突而不是拉取。 */
B.state.ui.scale = 1.2;
B.state.engine = 'duckduckgo';
eq('B 先推一份自己的状态', (await sync(B, 'push')).status, 'pushed');
A.state.ui.scale = 1.2;
A.state.engine = 'baidu';
eq('A 制造远端变化', (await sync(A, 'push')).status, 'pushed');
const nSnap0 = (await listSnapshots()).length;
eq('清空后快照数为 0', nSnap0, 0);
r = await sync(B);
eq('B 覆盖本地', r.status, 'pulled');
const snaps = await listSnapshots();
eq('覆盖本地前留了一份快照', snaps.length, 1);
eq('快照 reason=sync', snaps[0].reason, 'sync');
const saved = await readSnapshot(snaps[0].ts);
ok('快照只含状态树字段', Object.keys(saved.state).every((k) => SNAP_FIELDS.includes(k)),
  Object.keys(saved.state).join(','));
eq('快照保存的是覆盖前的引擎', saved.state.engine, 'duckduckgo');
ok('快照不含壁纸二进制', !JSON.stringify(saved.state).includes('image/jpeg'));

/* 恢复到覆盖前，再主动拉一次，两端重新收敛 */
const restored = await restoreSnapshot(snaps[0].ts, B.state);
ok('恢复返回了快照状态', !!restored && restored.engine === 'duckduckgo');
for (const k of SNAP_FIELDS) if (k in restored) B.state[k] = restored[k];
eq('B 回滚成功', B.state.engine, 'duckduckgo');
ok('恢复前自动留了一份 manual 备份', (await listSnapshots()).some((x) => x.reason === 'manual'));
eq('同一状态不重复存快照', (await (async () => {
  const n = (await listSnapshots()).length;
  await takeSnapshot(B.state, 'auto');
  await takeSnapshot(B.state, 'auto');
  return (await listSnapshots()).length - n;
})()), 1);
r = await sync(B, 'pull');
eq('回滚后主动拉取成功', r.status, 'pulled');
eq('回滚后重新收敛到远端引擎', B.state.engine, 'baidu');
eq('回滚后端状态哈希一致', await hashOf(B.state), await hashOf(A.state));

/* ============ 8. 请求形态与收尾 ============ */

ok('确实发生过 412 回源', requests.filter((x) => x.startsWith('PUT')).length >= 6);
ok('创建过目录（MKCOL）', requests.some((x) => x.startsWith('MKCOL')));
ok('整个测试没有留下未消费的伪造 etag', forcedPullEtag === null);

server.close();
await new Promise((resolve) => setTimeout(resolve, 50));

console.log(`\n通过 ${pass} 项`);
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ 虚拟双设备同步测试全部通过');
