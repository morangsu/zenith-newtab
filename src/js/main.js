/* 入口：先渲染（同步、不等任何 Promise），再做异步补水（壁纸、图标、书签）。
 * 设置面板、快照、轮播这些「用户不点就用不到」的代码全部按需 import，
 * 不进首屏解析链路 —— 这是本版把功能变多而启动不变慢的关键。 */
import { createStore, linksOf, veilOf, themeAt } from './store.js';
import { t, applyStaticStrings, setLanguage, currentLang } from './i18n.js';
import { startClock } from './clock.js';
import { createSearch } from './search.js';
import { loadWallpaperBlob, saveWallpaperShot, loadWallpaperShot, enableFirefoxCapture, hasTabsPermission } from './favicon.js';
import { mountBoard } from './board.js';
import { syncNow } from './sync.js';
import { ext, IS_FIREFOX, pickTone } from './util.js';

/* body 已解析完（module 在文档末尾），把静态文案按当前语言重填一次。
   HTML 里的默认文案本来就是简体中文，中文用户这一轮全文档查询是纯浪费，
   直接跳过；英文用户在这一帧切过去。切换语言时 refreshLocalizedUi 会
   无条件重填（那时 DOM 里可能是英文，不能跳过）。 */
if (currentLang() !== 'zh_CN') applyStaticStrings();

const bootAt = (window.__ZL_BOOT && window.__ZL_BOOT.t0) || performance.now();

const store = createStore();
const { state } = store;

const boardEl = document.getElementById('board');
const bgEl = document.getElementById('bg');
const clockEl = document.getElementById('clock');
const gear = document.getElementById('gear');

let bookmarkCandidates = [];

function candidates() {
  return linksOf(state)
    .map((l) => ({ title: l.title, url: l.url, kind: t('icon.siteCandidate') }))
    .concat(bookmarkCandidates);
}

const search = createSearch({
  getEngineId: () => state.engine,
  getCandidates: candidates,
  onNavigate: (url, engineId) => {
    if (engineId) {
      store.commit((s) => { s.engine = engineId; });
      return;
    }
    if (url) location.href = url;
  }
});
search.setEngine(state.engine);

startClock(document);
const board = mountBoard(boardEl, store);

/* ---------- 显示开关 / 主题 ---------- */

function effectiveTheme() {
  return themeAt(state.theme) || state.theme.mode;
}

function applyDisplay() {
  const root = document.documentElement;
  root.setAttribute('data-zen', state.ui.zen ? '1' : '0');
  root.setAttribute('data-search', state.ui.search ? '1' : '0');
  const addBtn = document.getElementById('widget-add');
  if (addBtn) addBtn.hidden = !state.ui.showAdd;
}

function applyThemeNow() {
  const root = document.documentElement;
  const forced = themeAt(state.theme);
  if (forced) root.setAttribute('data-theme', forced);
  else if (state.theme.mode === 'auto') root.removeAttribute('data-theme');
}

/* boot.js 读的是 localStorage 里的原始值，旧数据可能还没有 imageDim；
   这里用已经过 normalize 的状态再写一次，保证升级后遮罩也是对的。
   时段主题生效时按「手动主题」算遮罩，与 boot.js 的口径一致。 */
function applyVeil() {
  const wp = state.wallpaper || {};
  document.documentElement.style.setProperty('--veil-a', String(veilOf(wp, effectiveTheme())));
  document.documentElement.setAttribute('data-wall', wp.type === 'image' ? 'image' : 'preset');
}

applyDisplay();
applyThemeNow();
applyVeil();

/* 页面开着跨过时段边界时也要跟上；每分钟一次，开销可忽略 */
setInterval(() => {
  applyThemeNow();
  applyVeil();
}, 60000);

function onDisplayChange() {
  applyDisplay();
  applyThemeNow();
  applyVeil();
}

/* ---------- 按壁纸自动配色 ---------- */

const sampleCanvas = document.createElement('canvas');
let wallBitmap = null;

function luminanceBehindContent(bmp) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const scale = Math.max(vw / bmp.width, vh / bmp.height);
  const dw = bmp.width * scale;
  const dh = bmp.height * scale;
  const ox = (vw - dw) / 2;
  const oy = (vh - dh) / 2;

  const stage = document.querySelector('.stage');
  if (!stage) return 0.5;
  const r = stage.getBoundingClientRect();
  const padX = r.width * 0.06;
  const padY = r.height * 0.06;
  const left = Math.max(0, r.left + padX);
  const top = Math.max(0, r.top + padY);
  const w = Math.min(vw, r.right - padX) - left;
  const h = Math.min(vh, r.bottom - padY) - top;
  if (w <= 0 || h <= 0) return 0.5;

  const sx = Math.max(0, (left - ox) / scale);
  const sy = Math.max(0, (top - oy) / scale);
  const sw = Math.min(bmp.width - sx, w / scale);
  const sh = Math.min(bmp.height - sy, h / scale);
  if (sw <= 0 || sh <= 0) return 0.5;

  const N = 16;
  sampleCanvas.width = N;
  sampleCanvas.height = N;
  const ctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, N, N);
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, N, N);

  const linear = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };

  try {
    const data = ctx.getImageData(0, 0, N, N).data;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      sum += 0.2126 * linear(data[i]) + 0.7152 * linear(data[i + 1]) + 0.0722 * linear(data[i + 2]);
      n++;
    }
    return n ? sum / n : 0.5;
  } catch {
    return 0.5;
  }
}

let adaptPending = 0;
const ADAPT_KEY = 'zl.adapt';

function readAdaptCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(ADAPT_KEY) || 'null');
    return raw && typeof raw.tone === 'string' ? raw : null;
  } catch {
    return null;
  }
}

function writeAdaptCache(key, tone) {
  try {
    localStorage.setItem(ADAPT_KEY, JSON.stringify({ key, tone }));
  } catch { /* 配额满就每次重算 */ }
}

function clearAdaptCache() {
  try { localStorage.removeItem(ADAPT_KEY); } catch { /* 忽略 */ }
}

function blobKey(blob) {
  return (state.wallpaper.imageKey || '') + '|' + blob.size + '|' + (blob.type || '');
}

let bmpKey = '';

async function adaptColors(opts) {
  const force = !!(opts && opts.force);
  const root = document.documentElement;
  /* 手动主题或时段主题都已定死明暗，不再做自动配色（避免两套逻辑打架） */
  const auto = state.theme.mode === 'auto' && themeAt(state.theme) === null;
  if (!auto || state.wallpaper.type !== 'image') {
    root.removeAttribute('data-adapt');
    return;
  }
  const blob = await loadWallpaperBlob();
  if (!blob) {
    root.removeAttribute('data-adapt');
    return;
  }

  const key = blobKey(blob);
  if (wallBitmap && bmpKey === key) {
    const tone = pickTone(luminanceBehindContent(wallBitmap));
    root.setAttribute('data-adapt', tone);
    writeAdaptCache(key, tone);
    return;
  }

  if (!force) {
    const cached = readAdaptCache();
    if (cached && cached.key === key) {
      root.setAttribute('data-adapt', cached.tone);
      return;
    }
  }

  try {
    wallBitmap = await createImageBitmap(blob);
    bmpKey = key;
    const tone = pickTone(luminanceBehindContent(wallBitmap));
    root.setAttribute('data-adapt', tone);
    writeAdaptCache(key, tone);
  } catch {
    root.removeAttribute('data-adapt');
  }
}

function scheduleAdapt(delay = 220, force = true) {
  clearTimeout(adaptPending);
  adaptPending = setTimeout(() => adaptColors({ force }), delay);
}

adaptColors();
window.addEventListener('resize', () => scheduleAdapt(320, true));
document.addEventListener('zl:wallpaper', () => {
  wallBitmap = null;
  bmpKey = '';
  clearAdaptCache();
  scheduleAdapt(0, true);
});

if (window.MutationObserver && boardEl) {
  new MutationObserver(() => scheduleAdapt()).observe(boardEl, {
    attributes: true,
    attributeFilter: ['style', 'class'],
    subtree: true,
    childList: true
  });
}

/* 极简模式：点时间进入，点时间或按 Esc 退出 */
clockEl.addEventListener('click', () => {
  store.commit((s) => { s.ui.zen = !s.ui.zen; });
  applyDisplay();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.ui.zen) {
    store.commit((s) => { s.ui.zen = false; });
    applyDisplay();
  }
});

/* ---------- 首帧计时 ---------- */

requestAnimationFrame(() => {
  const rendered = performance.now();
  performance.mark('zl:rendered');
  try {
    sessionStorage.setItem(
      'zl.perf',
      JSON.stringify({
        boot: Math.round(bootAt * 100) / 100,
        rendered: Math.round((rendered - bootAt) * 100) / 100
      })
    );
  } catch { /* 忽略 */ }
});

/* ---------- 覆盖本地前留一份快照（同步层不依赖 IndexedDB） ---------- */

const onBeforeOverwrite = async () => {
  const { takeSnapshot } = await import('./snapshots.js');
  await takeSnapshot(state, 'sync');
};

/* 状态变化后延迟生成一次自动快照：commit 才会触发，组件内部输入走 persist
   不触发，避免每个按键都跑 canonical + SHA-256。 */
let snapTimer = 0;
store.onChange(() => {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => {
    import('./snapshots.js')
      .then((m) => m.takeSnapshot(state, 'auto'))
      .catch(() => {});
  }, 1500);
});

/* ---------- 异步补水 ---------- */

async function restoreWallpaper() {
  if (state.wallpaper.type !== 'image') return;
  const need = Math.max(window.innerWidth, window.innerHeight) * (window.devicePixelRatio || 1);
  if (loadWallpaperShot() && need <= 1600) return;

  const blob = await loadWallpaperBlob();
  if (!blob) return;
  bgEl.style.backgroundImage = `url("${URL.createObjectURL(blob)}")`;
  if (!loadWallpaperShot()) await saveWallpaperShot(blob);
}

restoreWallpaper();

if (ext && ext.permissions) {
  ext.permissions
    .contains({ permissions: ['bookmarks'] })
    .then(async (ok) => {
      if (!ok || !ext.bookmarks) return;
      const { flattenBookmarks } = await import('./bookmarks.js');
      bookmarkCandidates = await flattenBookmarks();
    })
    .catch(() => {});
}

/* ---------- 设置面板：首次点击才加载 ---------- */

let settingsApi = null;

function refreshLocalizedUi() {
  setLanguage(state.ui.lang);
  applyStaticStrings();
  board.render();
  const hint = document.getElementById('icon-hint');
  if (hint && !hint.dataset.busy) hint.textContent = t('icon.enableSite');
  if (settingsApi) settingsApi.render();
  onDisplayChange();
}

const settingsOpts = {
  store,
  search,
  onBookmarks: (list) => { bookmarkCandidates = list; },
  onIconsChanged: () => {
    const hint = document.getElementById('icon-hint');
    if (hint) hint.remove();
    board.render();
  },
  onDisplayChange,
  onLayoutChange: () => board.render(),
  onLanguageChange: refreshLocalizedUi,
  onBeforeOverwrite,
  onWallpaperChange: () => {
    wallBitmap = null;
    bmpKey = '';
    clearAdaptCache();
    scheduleAdapt(0, true);
  }
};

gear.addEventListener('click', async () => {
  if (!settingsApi) {
    gear.disabled = true;
    try {
      const { mountSettings } = await import('./settings.js');
      settingsApi = mountSettings(settingsOpts);
    } finally {
      gear.disabled = false;
    }
  }
  settingsApi.open();
});

/* Firefox 没有 _favicon，必须由用户授权 tabs 才能读图标。 */
async function maybeIconHint() {
  if (!IS_FIREFOX) return;
  if (await hasTabsPermission()) return;
  if (document.getElementById('icon-hint')) return;

  const btn = document.createElement('button');
  btn.id = 'icon-hint';
  btn.type = 'button';
  btn.className = 'chip';
  btn.textContent = t('icon.enableSite');
  btn.addEventListener('click', async () => {
    btn.dataset.busy = '1';
    btn.textContent = t('icon.reading');
    const res = await enableFirefoxCapture();
    if (res && res.ok) {
      btn.remove();
      board.render();
    } else {
      delete btn.dataset.busy;
      btn.textContent = t('icon.siteIconsFailed', (res && res.reason) || 'unknown');
    }
  });
  document.querySelector('.stage').append(btn);
}

maybeIconHint();

/* 打开新标签页时检查是否到了同步间隔（默认 24 小时）；没配置就什么都不做 */
setTimeout(() => {
  syncNow(state, { persist: () => store.flush(), onBeforeOverwrite })
    .then((res) => {
      if (res && res.status === 'pulled') location.reload();
    })
    .catch(() => {});
}, 1500);

/* 壁纸轮播：在空闲时为「下一次打开」预生成预览，本次不换图、不闪。
   没开轮播时这一步连模块都不加载。 */
function whenIdle(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 5000 });
  else setTimeout(fn, 2000);
}
/* 非首屏字典按需补齐：组件名、看板文案都在核心字典里，所以只有真的要
   打开设置或添加非默认组件时才需要它。首次交互（点/按键）立即预取，
   用户从按下到选完组件有足够时间；从头到尾不交互的新标签页就完全不解析
   这 6.8 KB。settings.js 自己也会静态 import 并 extend（extend 幂等），
   所以即使预取没赶上也不会缺文案。 */
let extraStringsPending = null;
function ensureExtraStrings() {
  if (extraStringsPending) return extraStringsPending;
  extraStringsPending = import('./strings-extra.js')
    .then((m) => {
      if (globalThis.ZL_I18N && globalThis.ZL_I18N.extend) globalThis.ZL_I18N.extend(m.default);
    })
    .catch(() => {});
  return extraStringsPending;
}
for (const ev of ['pointerdown', 'keydown']) {
  addEventListener(ev, ensureExtraStrings, { once: true, capture: true, passive: true });
}

whenIdle(() => {
  if (!state.wallpaper || !state.wallpaper.rotate) return;
  import('./wallpapers.js')
    .then((m) => m.prepareNextWallpaper(state))
    .catch(() => {});
});
