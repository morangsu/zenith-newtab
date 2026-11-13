/* 图标数据源：Chromium 走 _favicon 接口（读浏览器本地缓存，零网络零存储）；
   Firefox 没有 _favicon，由后台把标签页的 favIconUrl（data: URI）写进 IndexedDB。
   展示与像素处理在 iconview.js，这里只管「图标从哪来」。 */

import { ext, pickTone } from './util.js';
import { idbGet, idbAll, STORE_ICONS, STORE_KV, idbPut } from './idb.js';

export const ICON_MAX_BYTES = 256 * 1024;

/* 只接受 base64 内联的图片，其余（http:、chrome:、about:）一律拒绝——
   这条规则同时保证了「不联网」。 */
const DATA_URI_RE =
  /^data:(image\/(?:png|jpe?g|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon));base64,([A-Za-z0-9+/=\s]+)$/i;

export function parseDataImage(uri, maxBytes = ICON_MAX_BYTES) {
  if (typeof uri !== 'string') return null;
  const m = DATA_URI_RE.exec(uri.trim());
  if (!m) return null;

  const mime = m[1].toLowerCase();
  const b64 = m[2].replace(/\s+/g, '');
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((b64.length * 3) / 4) - pad;
  if (bytes <= 0 || bytes > maxBytes) return null;

  let bin;
  try {
    if (typeof atob === 'function') bin = atob(b64);
    else bin = Buffer.from(b64, 'base64').toString('binary');
  } catch {
    return null;
  }

  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  return { mime, bytes, data };
}

export async function saveWallpaperBlob(blob) {
  await idbPut(STORE_KV, 'wallpaper', blob);
}

/* ---------- 壁纸首帧缓存 ----------
   IndexedDB 是异步的，boot.js（<head> 同步脚本）读不了它——图片壁纸
   只能等主流程异步读完才出现，首帧是纯色，图随后突然出现，就是「闪屏」。
   解法（同类项目 Beautiful Photos / PlainTab 的做法）：把壁纸压一份
   data URL 存 localStorage，boot.js 同步取出直接上屏，首帧即壁纸。
   原图仍在 IndexedDB（导出/同步用），主流程异步加载后无缝覆盖。 */

export const WALLPAPER_SHOT_KEY = 'zl.wallpaper.shot';
export const WALLPAPER_AVG_KEY = 'zl.wallpaper.avg';
export const WALLPAPER_TONE_KEY = 'zl.wallpaper.tone';

/* 压缩：最长边 1600px、WebP q0.85（不支持时回退 JPEG），≈100-300KB。
   超过 600KB（个别浏览器把 webp 存成 png）就放弃缓存，回退旧行为。
   顺手把壁纸的**均色**与**明暗倾向**也存了：boot.js 拿均色做首帧打底色
   （浏览器深色主题 + 浅色壁纸时，打底色跟壁纸走而不是跟系统走），
   拿倾向提前决定文字方向，省掉一次可见的颜色翻转。 */
export async function saveWallpaperShot(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();

    let url = c.toDataURL('image/webp', 0.85);
    if (!url.startsWith('data:image/webp') || url.length > 500 * 1024) {
      url = c.toDataURL('image/jpeg', 0.85);
    }
    const fits = url.length <= 600 * 1024;

    try {
      const image = ctx.getImageData(0, 0, w, h).data;
      let r = 0;
      let g = 0;
      let b = 0;
      const n = w * h;
      for (let p = 0; p < n; p++) {
        r += image[p * 4];
        g += image[p * 4 + 1];
        b += image[p * 4 + 2];
      }
      const avg = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
      /* 相对亮度（sRGB 线性化），给 pickTone 判明暗方向 */
      const lin = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      const L = 0.2126 * lin(avg[0]) + 0.7152 * lin(avg[1]) + 0.0722 * lin(avg[2]);
      localStorage.setItem(WALLPAPER_AVG_KEY, avg.join(','));
      localStorage.setItem(WALLPAPER_TONE_KEY, pickTone(L));
    } catch {
      /* 存不上就算了：打底色回退主题色 */
    }

    if (!fits) {
      clearWallpaperShot();
      return false;
    }
    try {
      localStorage.setItem(WALLPAPER_SHOT_KEY, url);
      return true;
    } catch {
      /* 配额不足：保持无缓存，回退旧行为 */
      return false;
    }
  } catch {
    return false;
  }
}

export function loadWallpaperShot() {
  try {
    return localStorage.getItem(WALLPAPER_SHOT_KEY);
  } catch {
    return null;
  }
}

export function clearWallpaperShot() {
  try {
    localStorage.removeItem(WALLPAPER_SHOT_KEY);
    localStorage.removeItem(WALLPAPER_AVG_KEY);
    localStorage.removeItem(WALLPAPER_TONE_KEY);
  } catch {
    /* 忽略 */
  }
}

export async function loadWallpaperBlob() {
  try {
    return await idbGet(STORE_KV, 'wallpaper');
  } catch {
    return null;
  }
}

export async function countCachedIcons() {
  try {
    return (await idbAll(STORE_ICONS)).length;
  } catch {
    return 0;
  }
}

/* ---------- Firefox 专用：申请权限并让后台扫描已开标签页 ---------- */

export async function hasTabsPermission() {
  if (!ext || !ext.permissions) return false;
  try {
    return await ext.permissions.contains({ permissions: ['tabs'] });
  } catch {
    return false;
  }
}

export async function enableFirefoxCapture() {
  if (!ext || !ext.permissions) return { ok: false, reason: 'no-api' };
  let granted = false;
  try {
    granted = await ext.permissions.request({ permissions: ['tabs'] });
  } catch {
    granted = false;
  }
  if (!granted) return { ok: false, reason: 'denied' };
  try {
    const res = await ext.runtime.sendMessage({ type: 'zl:scan-tabs' });
    if (!res) return { ok: false, reason: 'no-response' };
    return res;
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}
