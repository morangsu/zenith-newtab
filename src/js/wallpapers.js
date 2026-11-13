/* 本地壁纸轮播。
 *
 * 关键设计：**这一页显示的是上一次预生成好的预览**。每次打开新标签页，
 * 在首屏之后悄悄把「下一张」压成预览写进 localStorage，于是下一次打开时
 * boot.js 同步读到的就是新图——整个轮播过程没有任何可见闪烁，也不碰
 * IndexedDB 的首帧路径。索引只存 localStorage，不进 state，因此不会污染
 * 同步哈希（否则每个新标签页都会被当成「配置改了」去推一次）。 */
import { idbGet, idbPut, idbDel, STORE_KV } from './idb.js';
import { saveWallpaperShot } from './favicon.js';

export const ROT_INDEX_KEY = 'zl.rotate.index';
export const ROT_KEY = 'zl.wallpaper.rotKey';
export const MAX_SLIDES = 12;

export function slideKey() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function compressImage(file, maxWidth = 2560) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const w = Math.max(1, Math.round(img.width * scale));
      const hgt = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = hgt;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, hgt);
      canvas.toBlob((blob) => resolve(blob), 'image/webp', 0.86);
    };
    img.onerror = () => reject(new Error('decode-failed'));
    img.src = URL.createObjectURL(file);
  });
}

function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 配额满就退化为单张 */ }
}

export function clearRotationCache() {
  try {
    localStorage.removeItem(ROT_KEY);
    localStorage.removeItem(ROT_INDEX_KEY);
  } catch { /* 忽略 */ }
}

function rotIndex() {
  try {
    const n = Number(localStorage.getItem(ROT_INDEX_KEY));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/* 上传一组图：全部写入 IDB，第一张立刻作为当前壁纸并生成首帧预览。
   返回新增的键数组，state 由调用方在 commit 里合并。 */
export async function addWallpaperSlides(files) {
  const added = [];
  for (const file of files.slice(0, MAX_SLIDES)) {
    try {
      const blob = await compressImage(file);
      if (!blob) continue;
      const key = slideKey();
      await idbPut(STORE_KV, 'wall.' + key, blob);
      added.push({ key, blob });
    } catch { /* 单张失败不影响其它 */ }
  }
  return added;
}

/* 把某张设为当前显示（同时写原图键、预览、轮播索引）。 */
export async function activateSlide(blob, key, index = 0) {
  await idbPut(STORE_KV, 'wallpaper', blob);
  const ok = await saveWallpaperShot(blob);
  store(ROT_KEY, key);
  store(ROT_INDEX_KEY, String(index));
  return ok;
}

export function removeSlideFiles(keys) {
  return Promise.all(keys.map((k) => idbDel(STORE_KV, 'wall.' + k).catch(() => {})));
}

/* 首屏之后调用：为「下一次打开」预备好下一张。不动 state、不触发渲染。 */
export async function prepareNextWallpaper(state) {
  const wp = (state && state.wallpaper) || {};
  if (wp.type !== 'image' || !wp.rotate || !Array.isArray(wp.slides) || wp.slides.length < 2) return false;

  const slides = wp.slides.slice(0, MAX_SLIDES);
  const cur = rotIndex();
  const next = (cur + 1) % slides.length;
  const key = slides[next] && slides[next].key;
  if (!key) return false;

  let blob;
  try {
    blob = await idbGet(STORE_KV, 'wall.' + key);
  } catch {
    return false;
  }
  if (!blob) return false;

  await idbPut(STORE_KV, 'wallpaper', blob);
  const ok = await saveWallpaperShot(blob);
  if (!ok) return false;
  store(ROT_KEY, key);
  store(ROT_INDEX_KEY, String(next));
  return true;
}
