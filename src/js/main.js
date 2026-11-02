/* 入口：先渲染（同步、不等任何 Promise），再做异步补水（壁纸、图标、书签）。 */
import { createStore, linksOf, veilOf } from './store.js';
import { startClock } from './clock.js';
import { createSearch } from './search.js';
import { loadWallpaperBlob, saveWallpaperShot, loadWallpaperShot, enableFirefoxCapture, hasTabsPermission } from './favicon.js';
import { mountSettings } from './settings.js';
import { mountBoard } from './board.js';
import { syncNow } from './sync.js';
import { ext, IS_FIREFOX, pickTone } from './util.js';

const bootAt = (window.__ZL_BOOT && window.__ZL_BOOT.t0) || performance.now();

const store = createStore();
const { state } = store;

const boardEl = document.getElementById('board');
const bgEl = document.getElementById('bg');
const clockEl = document.getElementById('clock');

let bookmarkCandidates = [];

function candidates() {
  return linksOf(state)
    .map((l) => ({ title: l.title, url: l.url, kind: '站点' }))
    .concat(bookmarkCandidates);
}

const search = createSearch({
  getEngineId: () => state.engine,
  getCandidates: candidates,
  onNavigate: (url, engineId) => {
    if (engineId) {
      store.commit((s) => {
        s.engine = engineId;
      });
      return;
    }
    if (url) location.href = url;
  }
});
search.setEngine(state.engine);

startClock(document);
const board = mountBoard(boardEl, store);

/* ---------- 显示开关 ---------- */

function applyDisplay() {
  const root = document.documentElement;
  root.setAttribute('data-zen', state.ui.zen ? '1' : '0');
  root.setAttribute('data-search', state.ui.search ? '1' : '0');
  const addBtn = document.getElementById('widget-add');
  if (addBtn) addBtn.hidden = !state.ui.showAdd;
}

applyDisplay();

/* ---------- 壁纸遮罩 ---------- */

/* boot.js 读的是 localStorage 里的原始值，旧数据可能还没有 imageDim；
   这里用已经过 normalize 的状态再写一次，保证升级后遮罩也是对的 */
function applyVeil() {
  const wp = state.wallpaper || {};
  document.documentElement.style.setProperty('--veil-a', String(veilOf(wp, state.theme && state.theme.mode)));
  document.documentElement.setAttribute('data-wall', wp.type === 'image' ? 'image' : 'preset');
}

applyVeil();

/* ---------- 按壁纸自动配色 ---------- */

/* 只在「跟随系统」且没手动指定主题时启用：这时候文字颜色本来就跟壁纸无关，
   壁纸一亮就白字压白。做法是把壁纸画进 16×16 的 canvas，算内容区背后的
   平均亮度，再挑「黑字」还是「白字」跟它对比更大。

   重算时机：壁纸换掉、内容区变了（拖组件、改尺寸、窗口缩放）。
   平时不算——这是静态结果，不需要每帧。 */

const sampleCanvas = document.createElement('canvas');
let wallBitmap = null;

/* 背景是 cover + center，把屏幕矩形映射回图片坐标 */
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
    /* blob: 和 data: 是同源的，正常不会污染画布；真出问题就退回默认 */
    return 0.5;
  }
}

let adaptPending = 0;
const ADAPT_KEY = 'zl.adapt';

/* 采样结果存起来：下次打开同一张图直接用，不用再把 2560px 的图解码一遍 */
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
  } catch {
    /* 配额满就每次重算，不影响正确性 */
  }
}

function clearAdaptCache() {
  try {
    localStorage.removeItem(ADAPT_KEY);
  } catch {
    /* 忽略 */
  }
}

/* 同一张图每次从 IndexedDB 读出来都是新的 Blob 实例，不能比引用，
   用「imageKey + 字节数 + 类型」当指纹 */
function blobKey(blob) {
  return (state.wallpaper.imageKey || '') + '|' + blob.size + '|' + (blob.type || '');
}

let bmpKey = '';

async function adaptColors(opts) {
  const force = !!(opts && opts.force);
  const root = document.documentElement;
  const auto = !state.theme || state.theme.mode === 'auto';
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

  /* 解码结果还在内存里（本次会话算过）：直接按当前布局重采，1ms 的事 */
  if (wallBitmap && bmpKey === key) {
    const tone = pickTone(luminanceBehindContent(wallBitmap));
    root.setAttribute('data-adapt', tone);
    writeAdaptCache(key, tone);
    return;
  }

  /* 首次打开同一张图：命中缓存就不再解码 */
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

/* 布局变了要按新区域重算，所以带 force */
function scheduleAdapt(delay = 220, force = true) {
  clearTimeout(adaptPending);
  adaptPending = setTimeout(() => {
    adaptColors({ force });
  }, delay);
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
  store.commit((s) => {
    s.ui.zen = !s.ui.zen;
  });
  applyDisplay();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.ui.zen) {
    store.commit((s) => {
      s.ui.zen = false;
    });
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
  } catch {
    /* 忽略 */
  }
});

/* ---------- 异步补水 ---------- */

async function restoreWallpaper() {
  if (state.wallpaper.type !== 'image') return;

  /* 首帧缓存已覆盖视口时直接用预览，不再读 IDB + 解码 2560px 原图——
     每个新标签页省一次 IndexedDB 读和一次大图解码，视觉上没有差别。
     大屏（或高分屏）超出预览分辨率时才加载原图。 */
  const need = Math.max(window.innerWidth, window.innerHeight) * (window.devicePixelRatio || 1);
  if (loadWallpaperShot() && need <= 1600) return;

  const blob = await loadWallpaperBlob();
  if (!blob) return;
  bgEl.style.backgroundImage = `url("${URL.createObjectURL(blob)}")`;

  /* 首帧缓存缺失（老版本升级后的第一次）：现在生成，下一个新标签页
     就能首帧直接出壁纸，不再闪。已有缓存时跳过，别每次开页都压图。 */
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

mountSettings({
  store,
  search,
  onBookmarks: (list) => {
    bookmarkCandidates = list;
  },
  onIconsChanged: () => {
    const hint = document.getElementById('icon-hint');
    if (hint) hint.remove();
    board.render();
  },
  onDisplayChange: applyDisplay,
  onLayoutChange: () => board.render()
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
  btn.textContent = '启用网站图标';
  btn.addEventListener('click', async () => {
    btn.textContent = '正在读取…';
    const res = await enableFirefoxCapture();
    if (res && res.ok) {
      btn.remove();
      board.render();
    } else {
      btn.textContent = `没能拿到图标（${(res && res.reason) || 'unknown'}）`;
    }
  });

  document.querySelector('.stage').append(btn);
}

maybeIconHint();

/* 打开新标签页时检查是否到了同步间隔（默认 24 小时）；没配置就什么都不做 */
setTimeout(() => {
  syncNow(state, { persist: () => store.flush() })
    .then((res) => {
      if (res && res.status === 'pulled') location.reload();
    })
    .catch(() => {});
}, 1500);
