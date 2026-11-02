/* 配置打包：导出/导入一个自包含的 JSON，内含布局、壁纸图片和图标缓存。
   图标是二进制，用 base64 内嵌——不做 zip，省掉一个依赖，代价是体积大 1/3。 */
import { loadWallpaperBlob, saveWallpaperBlob, saveWallpaperShot } from './favicon.js';
import { idbAll, idbPut, idbClear, STORE_ICONS } from './idb.js';
import { configOf } from './sync.js';
import { bytesToB64, b64ToBytes } from './b64.js';

const APP = 'zenith';
const PACK_VERSION = 1;
const MAX_ICONS = 800;
const STATE_KEY = 'zl.state';

async function blobToB64(blob) {
  if (!blob) return null;
  const buf = await blob.arrayBuffer();
  return { mime: blob.type || 'application/octet-stream', b64: bytesToB64(new Uint8Array(buf)) };
}

/* ---------- 导出 ---------- */

export async function buildPack(state) {
  const config = configOf(state);
  delete config.app;

  const pack = {
    app: APP,
    packVersion: PACK_VERSION,
    exportedAt: new Date().toISOString(),
    config,
    wallpaper: null,
    icons: []
  };

  if (state.wallpaper && state.wallpaper.type === 'image') {
    const blob = await loadWallpaperBlob();
    if (blob) pack.wallpaper = await blobToB64(blob);
  }

  try {
    const rows = await idbAll(STORE_ICONS);
    for (const row of rows.slice(0, MAX_ICONS)) {
      const v = row.value || {};
      const image = v.blob ? await blobToB64(v.blob) : null;
      if (!image) continue;
      pack.icons.push({ host: row.key, ts: v.ts || 0, mime: image.mime, b64: image.b64 });
    }
  } catch {
    /* 读不到图标就只导出配置 */
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return { text: JSON.stringify(pack), filename: `zenith-backup-${stamp}.json`, pack };
}

export function downloadPack(text, filename) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------- 导入 ---------- */

export async function importPack(text) {
  let pack;
  try {
    pack = JSON.parse(text);
  } catch {
    return { ok: false, error: '不是有效的 JSON 文件' };
  }

  if (!pack || pack.app !== APP) return { ok: false, error: '不是 Zenith 的配置文件' };
  if (!pack.config || typeof pack.config !== 'object') return { ok: false, error: '配置文件缺少 config' };
  if ((pack.packVersion || 1) > PACK_VERSION) return { ok: false, error: '配置文件版本过新' };

  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(pack.config));
  } catch {
    return { ok: false, error: '写入本地存储失败（可能空间不足）' };
  }

  if (pack.wallpaper && pack.wallpaper.b64) {
    try {
      const bytes = b64ToBytes(pack.wallpaper.b64);
      const blob = new Blob([bytes], { type: pack.wallpaper.mime || 'image/webp' });
      await saveWallpaperBlob(blob);
      /* 首帧缓存也一起更新，导入完下一个新标签页就不闪 */
      await saveWallpaperShot(blob);
    } catch {
      /* 壁纸失败不影响配置 */
    }
  }

  if (Array.isArray(pack.icons) && pack.icons.length) {
    try {
      await idbClear(STORE_ICONS);
      for (const icon of pack.icons.slice(0, MAX_ICONS)) {
        if (!icon || !icon.host || !icon.b64) continue;
        const bytes = b64ToBytes(icon.b64);
        if (bytes.length > 256 * 1024) continue;
        await idbPut(STORE_ICONS, icon.host, {
          blob: new Blob([bytes], { type: icon.mime || 'image/png' }),
          mime: icon.mime || 'image/png',
          ts: icon.ts || Date.now(),
          hash: ''
        });
      }
    } catch {
      /* 图标导入失败不影响配置 */
    }
  }

  return { ok: true, counts: { icons: (pack.icons || []).length, hasWallpaper: !!pack.wallpaper } };
}
