/* 图标渲染组件：决定每个 .icon 显示什么（自定义上传 / 站点 favicon / 字母兜底），
   以及按需做白底处理。性能上做了三件事：
   1. 处理结果统一缓存（src + 模式 为键），重渲染不再重复解码、重复抠图
   2. Firefox 的图标缓存一次 idbAll 批量读，不再逐个 await
   3. 有 createImageBitmap 时解码/处理走离屏位图，避开主线程光栅化
   像素级判定都在 iconproc.js（纯函数），这里只做编排。 */

import { IS_FIREFOX, ext, hostOf } from './util.js';
import { idbAll, STORE_ICONS } from './idb.js';
import { hasAlphaChannel, stripBackdropPixels } from './iconproc.js';

/* Chromium 专用：_favicon 接口读浏览器本地图标缓存 */
export function chromeFaviconUrl(url, size = 32) {
  const base = ext.runtime.getURL('/_favicon/');
  const u = new URL(base);
  u.searchParams.set('pageUrl', url);
  u.searchParams.set('size', String(size));
  return u.toString();
}

/* ---------- 缓存 ---------- */

/* key = `${mode}|${src}` → 处理后的 data URL，或 null 表示「处理过但放弃」。
   null 也要缓存，否则每次渲染都对同一张图重跑 canvas。 */
const processedCache = new Map();
const CACHE_MAX = 400;

function cacheGet(key) {
  return processedCache.get(key);
}

function cacheSet(key, value) {
  if (processedCache.size >= CACHE_MAX) {
    /* 简单淘汰：删最早写入的一批，避免 Map 无限长 */
    const drop = processedCache.size - CACHE_MAX + 32;
    let i = 0;
    for (const k of processedCache.keys()) {
      processedCache.delete(k);
      if (++i >= drop) break;
    }
  }
  processedCache.set(key, value);
}

/* Firefox：favIconUrl 的 blob 每次渲染都复用同一个 object URL */
const objUrlCache = new Map();

export function clearIconUrlCache() {
  for (const url of objUrlCache.values()) URL.revokeObjectURL(url);
  objUrlCache.clear();
  processedCache.clear();
}

/* ---------- 像素处理 ---------- */

function surface(w, h) {
  if (typeof OffscreenCanvas === 'function') {
    const oc = new OffscreenCanvas(w, h);
    return { ctx: oc.getContext('2d', { willReadFrequently: true }), toPNG: () => oc.convertToBlob({ type: 'image/png' }) };
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { ctx: c.getContext('2d', { willReadFrequently: true }), toPNG: () => c.toDataURL('image/png') };
}

/* 对已加载的图片做白底处理。
   mode='strip'：站点 favicon，白底板形态（含透明边距）
   mode='trim'：用户上传的透明图标，去掉贴边白
   两者底层是同一个泛洪判定，只是前置条件不同。
   返回处理后的 data URL，或 null 表示保持原图。 */
async function refine(img, mode) {
  try {
    if (!img.naturalWidth || !img.naturalHeight) return null;

    const MAX = 256;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));

    /* createImageBitmap 异步解码（可在后台线程光栅化），
       比旧的 drawImage(img) 同步路径少占主线程 */
    let src = img;
    if (typeof createImageBitmap === 'function') {
      try {
        src = await createImageBitmap(img);
      } catch {
        src = img;
      }
    }

    const { ctx, toPNG } = surface(w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    if (src !== img && src.close) src.close();

    const image = ctx.getImageData(0, 0, w, h);
    const d = image.data;

    if (mode === 'trim' && !hasAlphaChannel(d, w, h)) return null;

    if (!stripBackdropPixels(d, w, h)) return null;

    ctx.putImageData(image, 0, 0);
    /* convertToBlob 返回 Promise，必须 await——
       否则 instanceof Blob 判定在 Promise 上恒为 false，
       Blob 对象本身被当成 URL 赋给 img.src，得到一张坏图 */
    const out = await toPNG();
    if (out instanceof Blob) return await blobToDataURL(out);
    return out;
  } catch {
    return null;
  }
}

function blobToDataURL(blob) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}

/* ---------- 装载 ---------- */

/* 处理中的去重：同一张图并发请求只跑一次 canvas，结果共享给所有请求方 */
const pending = new Map();

/* 统一入口：给 img 设 src；需要处理时先显示原图，处理完异步换成结果，
   缓存命中则一步到位（不发两次 load）。 */
function attach(img, src, { mode = '', holder }) {
  img.addEventListener('load', () => {
    if (!mode) {
      reveal(img, holder);
      return;
    }
    const key = mode + '|' + src;
    const cached = cacheGet(key);
    if (cached !== undefined) {
      if (cached) {
        img.src = cached;
        markStripped(holder);
      }
      reveal(img, holder);
      return;
    }

    let task = pending.get(key);
    if (!task) {
      cacheSet(key, null);
      task = refine(img, mode).then((out) => {
        cacheSet(key, out);
        pending.delete(key);
        return out;
      });
      pending.set(key, task);
    }
    task.then((out) => {
      if (out) {
        img.src = out;
        markStripped(holder);
      }
      reveal(img, holder);
    });
  });
  img.src = src;
}

function reveal(img, holder) {
  img.style.opacity = '1';
  const el = holder || img.parentElement;
  if (el) el.classList.add('has-img');
}

function markStripped(holder) {
  const el = holder || null;
  if (el) el.classList.add('stripped');
}

/* ---------- 水合 ---------- */

/* 遍历容器里的 .icon[data-url]，按节点标记分流：
   data-custom="1" → 上传图标（item.icon 的 data URL）
   其余            → _favicon（Chromium）或 IndexedDB 里的 favIconUrl（Firefox） */
export async function hydrate(root, state) {
  const nodes = root.querySelectorAll('.icon[data-url]');
  if (!nodes.length) return;
  if (!ext || !ext.runtime) return;

  const strip = !state || !state.ui || state.ui.stripIconBg !== false;
  const trim = !!(state && state.ui && state.ui.trimCustomWhite);
  const byId = new Map((state && Array.isArray(state.items) ? state.items : []).map((it) => [it.id, it]));

  /* 自定义图标优先 */
  for (const node of nodes) {
    if (node.dataset.custom !== '1') continue;
    const img = node.querySelector('img');
    if (!img || node.classList.contains('has-img')) continue;
    const tile = node.closest('[data-id]');
    const item = tile ? byId.get(tile.dataset.id) : null;
    if (item && item.icon) {
      attach(img, item.icon, { mode: trim ? 'trim' : '', holder: node });
    }
  }

  if (!IS_FIREFOX) {
    for (const node of nodes) {
      if (node.dataset.custom === '1') continue;
      const img = node.querySelector('img');
      if (!img || node.classList.contains('has-img')) continue;
      attach(img, chromeFaviconUrl(node.dataset.url, 32), { mode: strip ? 'strip' : '', holder: node });
    }
    return;
  }

  /* Firefox：一次批量读出全部图标缓存，建 host → blobURL 映射 */
  const wanted = new Set();
  for (const node of nodes) {
    if (node.dataset.custom === '1') continue;
    const host = hostOf(node.dataset.url);
    if (host) wanted.add(host);
  }
  const hosts = await loadIconRecords([...wanted]);
  for (const node of nodes) {
    if (node.dataset.custom === '1') continue;
    const img = node.querySelector('img');
    if (!img || node.classList.contains('has-img')) continue;
    const host = hostOf(node.dataset.url);
    const src = host ? hosts.get(host) : null;
    if (src) attach(img, src, { mode: strip ? 'strip' : '', holder: node });
  }
}

let iconRecords = null;

async function loadIconRecords(hosts) {
  const out = new Map();
  if (!iconRecords) {
    try {
      const rows = await idbAll(STORE_ICONS);
      iconRecords = new Map();
      for (const row of rows) {
        const v = row.value || {};
        if (v.blob) {
          const url = URL.createObjectURL(v.blob);
          objUrlCache.set(row.key, url);
          iconRecords.set(row.key, url);
        }
      }
    } catch {
      iconRecords = new Map();
    }
  }
  for (const h of hosts) {
    const url = iconRecords.get(h);
    if (url) out.set(h, url);
  }
  return out;
}
