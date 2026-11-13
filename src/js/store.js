/* 状态：localStorage 是「同步镜像」，保证第一帧就能读到个性化数据；
   IndexedDB 只存二进制（壁纸、Firefox 图标），不进状态树。

   0.2.0 起图标与组件合并到同一个 items 数组，共用一个网格：
   { id, kind: 'link' | 'widget', cols, rows, ... }
   cols 以 8 列网格为基准。 */

export const STATE_KEY = 'zl.state';
export const SCHEMA = 2;
export const BASE_COLS = 8;

const SEED_LINKS = [
  { title: '哔哩哔哩', url: 'https://www.bilibili.com/' },
  { title: 'GitHub', url: 'https://github.com/' },
  { title: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  { title: '知乎', url: 'https://www.zhihu.com/' },
  { title: '网易云音乐', url: 'https://music.163.com/' },
  { title: 'iconfont', url: 'https://www.iconfont.cn/' },
  { title: 'MSN 新闻', url: 'https://www.msn.cn/' },
  { title: '贵州数字图书馆', url: 'https://www.gzlib.org/' }
];

export function defaultState() {
  const items = [
    { id: 'w-todo', kind: 'widget', type: 'todo', cols: 4, rows: 1 },
    { id: 'w-count', kind: 'widget', type: 'countdown', cols: 2, rows: 1 },
    { id: 'w-pomo', kind: 'widget', type: 'pomodoro', cols: 2, rows: 1 }
  ];
  SEED_LINKS.forEach((l, i) => {
    items.push({ id: 'seed-' + i, kind: 'link', title: l.title, url: l.url, cols: 1, rows: 1 });
  });

  return {
    v: SCHEMA,
    /* schedule 只在「跟随系统」下生效：按时段强制浅/深色，避免阴天白天也一片黑 */
    theme: { mode: 'auto', schedule: { enabled: false, dayStart: 7, nightStart: 19 } },
    ui: { scale: 1.15, search: true, showAdd: true, zen: false, lang: 'auto' },
    /* 三套遮罩强度，按「壁纸类型 × 主题模式」分开记：
       - dim：预设壁纸（一般 0，预设本身是均匀的）
       - imageDim：照片 + 手动主题，默认 35%——这时只能靠遮罩压平明暗
       - adaptDim：照片 + 跟随系统（自动配色），默认 15%——配色已经对上，
         遮罩只用来提亮/压暗局部，再重就成一层白雾了 */
    wallpaper: {
      type: 'preset',
      preset: 'aurora',
      dim: 0,
      imageDim: 0.35,
      adaptDim: 0.15,
      imageKey: null,
      /* 轮播只存「图片键」清单，图片本体在 IndexedDB，且不进同步（对面没有图） */
      slides: [],
      rotate: false
    },
    engine: 'bing',
    items,
    widgetData: {},
    /* 组件默认配置（按类型），由组件声明的 schema 统一渲染；见 config.js */
    widgetConfig: {},
    /* 按组件类型记录要不要参与同步：缺省=同步。
       只存本地（不进 configOf），每台设备可以有各自的选择。 */
    syncByType: {}
  };
}

/* 0.1.x 的数据：links 与 widgets 两个数组、4 列网格、带分组。
   合并成 items，列数按 4→8 翻倍。 */
function migrate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.v === SCHEMA && Array.isArray(raw.items)) return raw;

  const hasLegacy = Array.isArray(raw.links) || Array.isArray(raw.widgets);
  if (!hasLegacy) return null;

  const items = [];
  for (const w of raw.widgets || []) {
    items.push({
      id: w.id,
      kind: 'widget',
      type: w.type,
      cols: Math.min(BASE_COLS, (w.cols || 1) * 2),
      rows: w.rows || 1
    });
  }
  for (const l of raw.links || []) {
    items.push({
      id: l.id || 'l-' + items.length,
      kind: 'link',
      title: l.title || l.url,
      url: l.url,
      cols: 1,
      rows: 1
    });
  }

  return {
    ...raw,
    v: SCHEMA,
    items,
    widgetData: raw.widgetData && typeof raw.widgetData === 'object' ? raw.widgetData : {}
  };
}

function clampHour(v, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : fallback;
}

export function normalizeWallpaper(wp, fallback) {
  var d = typeof wp.dim === 'number' ? Math.min(0.8, Math.max(0, wp.dim)) : fallback.dim;
  var id = typeof wp.imageDim === 'number' ? Math.min(0.8, Math.max(0, wp.imageDim)) : fallback.imageDim;
  var ad = typeof wp.adaptDim === 'number' ? Math.min(0.8, Math.max(0, wp.adaptDim)) : fallback.adaptDim;
  return { ...wp, dim: d, imageDim: id, adaptDim: ad };
}

function normalize(raw) {
  const migrated = migrate(raw);
  if (!migrated) return defaultState();

  const s = defaultState();
  const ui = { ...s.ui, ...(migrated.ui || {}) };
  ui.scale = Math.min(1.6, Math.max(0.85, Number(ui.scale) || s.ui.scale));
  ui.search = ui.search !== false;
  ui.showAdd = ui.showAdd !== false;
  ui.zen = ui.zen === true;
  if (ui.lang !== 'zh_CN' && ui.lang !== 'en') ui.lang = 'auto';

  const items = Array.isArray(migrated.items)
    ? migrated.items.filter((it) => it && (it.kind === 'link' ? it.url : it.type))
    : s.items;

  const rawTheme = migrated.theme || {};
  const rawSchedule = rawTheme.schedule || {};
  const day = clampHour(rawSchedule.dayStart, 7);
  const night = clampHour(rawSchedule.nightStart, 19);
  const theme = {
    mode: rawTheme.mode === 'light' || rawTheme.mode === 'dark' ? rawTheme.mode : 'auto',
    schedule: { enabled: rawSchedule.enabled === true, dayStart: day, nightStart: night }
  };

  const wp = { ...s.wallpaper, ...(migrated.wallpaper || {}) };
  const slides = Array.isArray(wp.slides)
    ? wp.slides.filter((x) => x && typeof x.key === 'string').slice(0, 24)
    : [];

  return {
    ...s,
    ...migrated,
    v: SCHEMA,
    ui,
    theme,
    wallpaper: { ...normalizeWallpaper(wp, s.wallpaper), slides, rotate: wp.rotate === true },
    items: items.length ? items : s.items,
    widgetData: migrated.widgetData || {},
    widgetConfig:
      migrated.widgetConfig && typeof migrated.widgetConfig === 'object' ? migrated.widgetConfig : {},
    syncByType:
      migrated.syncByType && typeof migrated.syncByType === 'object' ? migrated.syncByType : {}
  };
}

export function loadState() {
  const boot = typeof window !== 'undefined' ? window.__ZL_BOOT : null;
  if (boot && boot.snap) return normalize(boot.snap);
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch {
    /* 损坏就从默认值开始，不阻塞首屏 */
  }
  return defaultState();
}

export function createStore(initial) {
  const state = initial || loadState();
  const listeners = new Set();
  let timer = 0;

  function write() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch {
      /* 配额满时静默失败，内存中的状态仍然可用 */
    }
  }

  function flush() {
    clearTimeout(timer);
    timer = 0;
    write();
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(write, 150);
  }

  function commit(mutator) {
    mutator(state);
    schedule();
    for (const fn of listeners) fn(state);
  }

  /* 只落盘，不通知渲染：组件内部数据（待办、便签、表达式）每秒都可能变，
     走 commit 会把整个页面重渲染一遍。 */
  function persist() {
    schedule();
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
  }

  return { state, commit, persist, onChange, flush };
}

export function uid() {
  return 'i-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

export function linksOf(state) {
  return state.items.filter((it) => it.kind === 'link');
}

/* 时段主题：返回 null 表示「跟随系统、不强制」，否则是 light / dark。
   boot.js 有一份等价的同步实现（它在 <head> 里不能 import ESM），
   两边都由 test/smoke.mjs 比对，避免首帧和主流程算出不同结果。 */
export function themeAt(theme, date = new Date()) {
  const mode = theme && (theme.mode === 'light' || theme.mode === 'dark') ? theme.mode : 'auto';
  if (mode !== 'auto') return mode;
  const s = theme && theme.schedule;
  if (!s || !s.enabled) return null;
  const hr = date.getHours();
  const d = clampHour(s.dayStart, 7);
  const n = clampHour(s.nightStart, 19);
  const isDay = d <= n ? hr >= d && hr < n : hr >= d || hr < n;
  return isDay ? 'light' : 'dark';
}

/* 当前该用多强的遮罩：预设 / 照片+手动主题 / 照片+跟随系统，三套分开 */
export function veilOf(wp, themeMode) {
  if (!wp) return 0;
  if (wp.type !== 'image') return typeof wp.dim === 'number' ? wp.dim : 0;
  const manual = themeMode === 'light' || themeMode === 'dark';
  const v = manual ? wp.imageDim : wp.adaptDim;
  return typeof v === 'number' ? v : 0;
}
