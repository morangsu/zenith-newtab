/* 0.13.0 新功能回归：i18n 覆盖 / 时段主题 / 组件配置协议 / 差异描述 /
   本地快照（内存 IndexedDB 桩）/ 孤立资源回收。
   node test/features.mjs 直接跑，不需要浏览器。 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

let pass = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) pass++;
  else failures.push(name + (extra ? '  → ' + extra : ''));
};
const eq = (name, a, b) => ok(name, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);

/* ---------- 内存 IndexedDB 桩（够 idb.js 用） ---------- */

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
        /* 同步给出 result：idb.js 在 transaction.oncomplete 才读它，
           真实 IDB 是异步的，桩只要保证这个取值顺序即可 */
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

/* ---------- 本地存储桩 ---------- */
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear()
};

makeFakeIdb();

/* ---------- 字典 ---------- */

const coreText = readFileSync(join(SRC, 'js/strings.js'), 'utf8');
const dictCtx = {
  window: {},
  navigator: { language: 'en-US' },
  document: {
    documentElement: { setAttribute() {}, lang: '' },
    querySelector: () => null,
    querySelectorAll: () => [],
    title: ''
  },
  console
};
vm.createContext(dictCtx);
vm.runInContext(coreText, dictCtx, { filename: 'strings.js' });
const I = dictCtx.window.ZL_I18N;
const { default: EXTRA } = await import('../src/js/strings-extra.js');

const coreRows = I.rows.slice();
ok('字典：核心至少 60 项', coreRows.length >= 60, String(coreRows.length));
ok('字典：补充至少 150 项', EXTRA.length >= 150, String(EXTRA.length));
const allKeys = new Set();
let dup = 0;
for (const r of [...coreRows, ...EXTRA]) {
  if (allKeys.has(r[0])) dup++;
  allKeys.add(r[0]);
  ok('字典：' + r[0] + ' 有中英两条', typeof r[1] === 'string' && typeof r[2] === 'string' && r[1] && r[2]);
}
eq('字典：无重复 key', dup, 0);

I.extend(EXTRA);
eq('字典：extend 后条目数', I.rows.length, coreRows.length + EXTRA.length);
eq('字典：extend 不覆盖核心', I.t('app.title'), '新标签页');
I.init('en');
eq('字典：英文标题', I.t('app.title'), 'New tab');
eq('字典：占位符替换', I.t('wall.rotationCount', 3), '3 images in rotation');
eq('字典：多占位符', I.t('sync.diffFields', 2, 4, 1), '2 settings, 4 sites, 1 widgets');
I.init('zh_CN');
eq('字典：中文标题', I.t('app.title'), '新标签页');
eq('字典：中文占位符', I.t('w.count.future', 12), '还有 12 天 · ');
I.init('auto');
eq('字典：跟随浏览器（en-US）', I.lang(), 'en');
dictCtx.navigator.language = 'zh-CN';
I.init('auto');
eq('字典：跟随浏览器（zh-CN）', I.lang(), 'zh_CN');
eq('字典：缺 key 回退成 key 本身', I.t('__missing__'), '__missing__');

/* 所有 t('字面量') 必须能在字典里找到 */
function walk(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const jsFiles = walk(join(SRC, 'js')).filter((f) => f.endsWith('.js'));
const missing = new Set();
const literalKeys = new Set();
for (const f of jsFiles) {
  const text = readFileSync(f, 'utf8');
  /* 只收完整的静态 key；t('widget.' + type) 这类拼接由下面的字面量扫描覆盖 */
  for (const m of text.matchAll(/\bt\(\s*'([^']+)'\s*[,)]/g)) {
    literalKeys.add(m[1]);
    if (!allKeys.has(m[1])) missing.add(relative(SRC, f) + ' → ' + m[1]);
  }
  /* 变量形式的 t(k)：只要字符串字面量在源码里出现过就算有来源 */
  for (const m of text.matchAll(/'((?:widget|cfg|sec|wall|theme|lang|sync|snap|w|board|icon|data|site|disp|diag|storage)\.[A-Za-z0-9_.]+)'/g)) {
    literalKeys.add(m[1]);
  }
}
eq('i18n：所有静态 t() 的 key 都在字典里', missing.size, 0);
if (missing.size) for (const m of missing) console.log('  ✗ ' + m);

/* HTML 静态文案属性 */
const html = readFileSync(join(SRC, 'newtab.html'), 'utf8');
for (const m of html.matchAll(/data-i18n(?:-ph|-title|-aria)?="([^"]+)"/g)) {
  ok('i18n：HTML ' + m[1] + ' 在字典里', allKeys.has(m[1]));
  literalKeys.add(m[1]);
}
/* main.js 在中文下跳过 applyStaticStrings()，前提就是 HTML 里写死的默认
   文案和字典中文一模一样。以后改文案时这里会挡住不一致。 */
I.init('zh_CN');
const attrOf = (s, name) => {
  /* 必须要求属性名前是空白，否则 \btitle= 会命中 data-i18n-title= */
  const m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(s);
  return m ? m[1] : null;
};
const STATIC_ATTRS = [
  ['data-i18n', 'textContent'],
  ['data-i18n-ph', 'placeholder'],
  ['data-i18n-title', 'title'],
  ['data-i18n-aria', 'aria-label']
];
let staticChecked = 0;
for (const m of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>([^<]*)/g)) {
  const attrs = m[2];
  for (const [flag, target] of STATIC_ATTRS) {
    const key = attrOf(attrs, flag);
    if (!key) continue;
    const actual = target === 'textContent' ? m[3].trim() : attrOf(attrs, target);
    if (actual == null) continue;
    eq('i18n：中文短路前提 ' + flag + '=' + key, actual, I.t(key));
    staticChecked++;
  }
}
ok('i18n：静态文案守卫覆盖到至少 6 处', staticChecked >= 6, String(staticChecked));

const unused = [...allKeys].filter((k) => !literalKeys.has(k));
console.log(`  （字典 ${allKeys.size} 项，源码引用 ${literalKeys.size} 项，未被字面量直接引用 ${unused.length} 项${unused.length ? '：' + unused.slice(0, 8).join(', ') : ''}）`);

/* ---------- 状态与时段主题 ---------- */

const { defaultState, loadState, themeAt, veilOf, normalizeWallpaper } = await import('../src/js/store.js');
const d = defaultState();
eq('状态：默认语言跟随浏览器', d.ui.lang, 'auto');
eq('状态：默认不开启时段主题', d.theme.schedule.enabled, false);
eq('状态：默认轮播为空', d.wallpaper.slides.length, 0);
ok('状态：默认有 widgetConfig', !!d.widgetConfig && typeof d.widgetConfig === 'object');

const at = (h) => new Date(2026, 10, 8, h, 30, 0);
eq('时段：关闭时跟随系统', themeAt({ mode: 'auto' }, at(13)), null);
eq('时段：白天浅色', themeAt({ mode: 'auto', schedule: { enabled: true, dayStart: 7, nightStart: 19 } }, at(13)), 'light');
eq('时段：夜间深色', themeAt({ mode: 'auto', schedule: { enabled: true, dayStart: 7, nightStart: 19 } }, at(23)), 'dark');
eq('时段：边界 7 点算白天', themeAt({ mode: 'auto', schedule: { enabled: true, dayStart: 7, nightStart: 19 } }, at(7)), 'light');
eq('时段：边界 19 点算夜间', themeAt({ mode: 'auto', schedule: { enabled: true, dayStart: 7, nightStart: 19 } }, at(19)), 'dark');
/* 白天 8:00→次日 2:00，夜间 2:00→8:00 */
eq('时段：跨午夜区间的 23 点仍是白天', themeAt({ mode: 'auto', schedule: { enabled: true, dayStart: 8, nightStart: 2 } }, at(23)), 'light');
eq('时段：跨午夜区间的 3 点是夜间', themeAt({ mode: 'auto', schedule: { enabled: true, dayStart: 8, nightStart: 2 } }, at(3)), 'dark');
eq('时段：手动主题优先', themeAt({ mode: 'dark', schedule: { enabled: true, dayStart: 7, nightStart: 19 } }, at(13)), 'dark');
eq('时段：非法小时回落', themeAt({ mode: 'auto', schedule: { enabled: true, dayStart: 99, nightStart: 99 } }, at(13)), 'light');

eq('遮罩：预设用 dim', veilOf({ type: 'preset', dim: 0.2 }, 'auto'), 0.2);
eq('遮罩：照片+自动用 adaptDim', veilOf({ type: 'image', imageDim: 0.35, adaptDim: 0.15 }, 'auto'), 0.15);
eq('遮罩：照片+手动用 imageDim', veilOf({ type: 'image', imageDim: 0.35, adaptDim: 0.15 }, 'dark'), 0.35);
eq('遮罩：上限 0.8', normalizeWallpaper({ dim: 5, imageDim: -1, adaptDim: 0.3 }, { dim: 0, imageDim: 0.35, adaptDim: 0.15 }).dim, 0.8);

/* 旧数据升级 */
mem.clear();
globalThis.window = undefined;
mem.set('zl.state', JSON.stringify({
  v: 2, items: [{ id: 'x', kind: 'link', url: 'https://a.com' }],
  theme: { mode: 'light' }, ui: { scale: 2.5 }, wallpaper: { type: 'preset' }
}));
const migrated = loadState();
eq('迁移：字号被夹到 1.6', migrated.ui.scale, 1.6);
eq('迁移：lang 补默认值', migrated.ui.lang, 'auto');
eq('迁移：schedule 补默认', migrated.theme.schedule.enabled, false);
eq('迁移：slides 补默认', migrated.wallpaper.slides.length, 0);
ok('迁移：widgetConfig 补默认', typeof migrated.widgetConfig === 'object');
eq('迁移：保留手动主题', migrated.theme.mode, 'light');

/* ---------- 组件配置协议 ---------- */

const { SCHEMAS, CONFIGURABLE, configFor, saveConfig, validateConfig, clampField } = await import('../src/js/config.js');
eq('配置：目前只有番茄钟声明了 schema', CONFIGURABLE.join(','), 'pomodoro');
const s1 = defaultState();
eq('配置：未存过时取 schema 默认', configFor(s1, 'pomodoro').focusMin, 25);
eq('配置：缺字段时回落', clampField('abc', SCHEMAS.pomodoro[0]), 25);
eq('配置：上限 180', validateConfig('pomodoro', { focusMin: 999, breakMin: 0 }).focusMin, 180);
eq('配置：下限 1', validateConfig('pomodoro', { focusMin: 0, breakMin: -5 }).breakMin, 1);
s1.items.push({ id: 'w-pomo-2', kind: 'widget', type: 'pomodoro', cols: 2, rows: 1 });
s1.widgetData['w-pomo-2'] = { focusMin: 40, breakMin: 9, remain: 100, running: true };
saveConfig(s1, 'pomodoro', { focusMin: 50, breakMin: 10 });
eq('配置：写回默认值', s1.widgetConfig.pomodoro.focusMin, 50);
eq('配置：已有实例被刷新', s1.widgetData['w-pomo-2'].focusMin, 50);
eq('配置：不碰实例的其它字段', s1.widgetData['w-pomo-2'].running, true);
eq('配置：configFor 读新默认值', configFor(s1, 'pomodoro').breakMin, 10);

/* ---------- 同步差异 ---------- */

const { diffConfigs, formatDiff } = await import('../src/js/diff.js');
const baseCfg = {
  theme: { mode: 'auto' }, ui: { scale: 1 }, engine: 'bing',
  wallpaper: { type: 'preset', slides: [{ key: 'a' }] },
  items: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
  widgetData: { a: { x: 1 } },
  widgetConfig: {}
};
const same = { ...baseCfg, wallpaper: { type: 'preset', slides: [{ key: 'DIFFERENT' }] } };
ok('差异：只有 slides 不同视为无变化（本机图片清单不参与比较）', diffConfigs(baseCfg, same).empty);
const changed = {
  ...baseCfg,
  ui: { scale: 1.3 },
  items: [{ id: 'a', title: 'A2' }, { id: 'c', title: 'C' }],
  widgetData: { a: { x: 2 } }
};
const diff = diffConfigs(baseCfg, changed);
ok('差异：检测到设置变化', diff.changed.includes('ui'));
eq('差异：新增站点', diff.added, 1);
eq('差异：移除站点', diff.removed, 1);
eq('差异：修改站点', diff.itemsChanged, 1);
eq('差异：组件数据变化', diff.widgetChanges, 1);
ok('差异：非空', !diff.empty);
const fakeT = (k, ...a) => k + '(' + a.join(',') + ')';
eq('差异：空差异文案', formatDiff(diffConfigs(baseCfg, baseCfg), fakeT), 'sync.noChanges()');
ok('差异：非空文案包含字段', formatDiff(diff, fakeT).includes('sync.diffFields'));

/* ---------- 同步配置不携带本机图片清单 ---------- */

const { configOf, syncConfigOf, buildSyncText } = await import('../src/js/sync.js');
const st = defaultState();
st.wallpaper = { ...st.wallpaper, type: 'image', imageKey: 'abc', slides: [{ key: 'x' }] };
eq('同步：configOf 剔除 imageKey', configOf(st).wallpaper.imageKey, null);
ok('同步：configOf 剔除 slides', !('slides' in configOf(st).wallpaper));
ok('同步：buildSyncText 不含 slides', !JSON.parse(buildSyncText(st, 'webdav')).wallpaper.slides);
st.syncByType = { todo: false };
st.items = [{ id: 'w1', kind: 'widget', type: 'todo', cols: 1, rows: 1 }, { id: 'w2', kind: 'widget', type: 'notes', cols: 1, rows: 1 }];
st.widgetData = { w1: { text: 'x' }, w2: { text: 'y' } };
eq('同步：被排除组件不上传', Object.keys(syncConfigOf(st).widgetData).join(','), 'w2');

/* ---------- 本地快照（真跑内存 IndexedDB） ---------- */

const {
  SNAP_LIMIT, snapshotState, countOf, listSnapshots,
  takeSnapshot, readSnapshot, restoreSnapshot, deleteSnapshot, clearSnapshots
} = await import('../src/js/snapshots.js');
const { STORE_SNAPS } = await import('../src/js/idb.js');
await clearSnapshots();

const ss = defaultState();
ss.items.push({ id: 'z', kind: 'link', url: 'https://z.example', icon: 'data:image/png;base64,AAAA' });
eq('快照：只挑状态字段', Object.keys(snapshotState(ss)).includes('syncByType'), true);
ok('快照：不含运行时临时字段', !('__runtime' in snapshotState(ss)));
eq('快照：计数含 items 与 widgetData', countOf(snapshotState(ss)), ss.items.length);

const r1 = await takeSnapshot(ss, 'auto');
ok('快照：首次会创建', r1.created);
const r2 = await takeSnapshot(ss, 'auto');
eq('快照：同状态不重复存', r2.created, false);
eq('快照：列表只有一份', (await listSnapshots()).length, 1);
ok('快照：保留了内联图标', (await readSnapshot(r1.ts)).state.items.some((i) => i.icon));

ss.ui.scale = 1.4;
const r3 = await takeSnapshot(ss, 'manual');
ok('快照：状态变化后新建', r3.created);
eq('快照：列表两份', (await listSnapshots()).length, 2);
eq('快照：最新排在前面', (await listSnapshots())[0].ts, r3.ts);

/* 故意把当前状态再改一次，确保「恢复前留备份」有东西可备份 */
ss.ui.scale = 1.5;
const beforeRestore = (await listSnapshots()).length;
const restored = await restoreSnapshot(r1.ts, ss);
ok('快照：恢复拿到状态', !!restored && restored.ui.scale === 1.15);
eq('快照：恢复前自动备份当前状态', (await listSnapshots()).length, beforeRestore + 1);

await deleteSnapshot(r1.ts);
eq('快照：删除生效', (await listSnapshots()).some((r) => r.ts === r1.ts), false);

/* 上限：连改 SNAP_LIMIT+4 次，列表不得超过上限 */
for (let i = 0; i < SNAP_LIMIT + 4; i++) {
  ss.ui.scale = 0.9 + i * 0.01;
  await takeSnapshot(ss, 'auto');
}
ok('快照：不超过上限', (await listSnapshots()).length <= SNAP_LIMIT,
  String((await listSnapshots()).length));
await clearSnapshots();
eq('快照：清空', (await listSnapshots()).length, 0);

/* ---------- 孤立资源回收 ---------- */

const { cleanupOrphans } = await import('../src/js/storage.js');
const { idbPut, STORE_ICONS, STORE_KV } = await import('../src/js/idb.js');
await idbPut(STORE_ICONS, 'a.com', { blob: 'x' });
await idbPut(STORE_ICONS, 'gone.com', { blob: 'y' });
await idbPut(STORE_KV, 'wall.keep', 'blob');
await idbPut(STORE_KV, 'wall.orphan', 'blob');
await idbPut(STORE_KV, 'wallpaper', 'blob');
const orphanState = defaultState();
orphanState.items = [{ id: 'a', kind: 'link', url: 'https://a.com', cols: 1, rows: 1 }];
orphanState.wallpaper.slides = [{ key: 'keep' }];
eq('回收：清掉 1 个孤立图标 + 1 张孤立壁纸', await cleanupOrphans(orphanState), 2);
const { idbAll } = await import('../src/js/idb.js');
eq('回收：保留在用的图标', (await idbAll(STORE_ICONS)).length, 1);
eq('回收：保留在用的壁纸与当前图', (await idbAll(STORE_KV)).length, 2);

/* ---------- IndexedDB 版本一致性（后台脚本必须同步升级） ---------- */

const bg = readFileSync(join(SRC, 'background.js'), 'utf8');
const idbSrc = readFileSync(join(SRC, 'js/idb.js'), 'utf8');
const vPage = /DB_VERSION\s*=\s*(\d+)/.exec(idbSrc)[1];
const vBg = /indexedDB\.open\('zl',\s*(\d+)\)/.exec(bg)[1];
eq('守卫：页面与后台使用同一个 IndexedDB 版本', vBg, vPage);
ok('守卫：后台升级时创建 snaps', bg.includes("createObjectStore('snaps')"));

/* ---------- 汇总 ---------- */
console.log(`\n通过 ${pass} 项`);
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ 全部通过');
