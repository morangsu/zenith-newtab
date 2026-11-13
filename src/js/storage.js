/* 本地存储治理：查配额、回收已经没人引用的二进制。
 * 只在用户点按钮时执行，绝不在首屏路径上遍历 IndexedDB。 */
import { idbAll, idbDel, STORE_ICONS, STORE_KV } from './idb.js';
import { hostOf } from './util.js';

export async function storageUsage() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const e = await navigator.storage.estimate();
    return { usage: Number(e.usage) || 0, quota: Number(e.quota) || 0 };
  } catch {
    return null;
  }
}

/* 判定哪些键还活着：
 *   icons 的 key 是站点 host
 *   kv 里 'wallpaper' 是当前壁纸，'wall.<key>' 是轮播图，其余 kv 键不动
 * 返回删掉的条数；不做任何隐式删除，调用方必须显式触发。 */
export async function cleanupOrphans(state) {
  const hosts = new Set();
  for (const it of (state && state.items) || []) {
    if (it && it.kind === 'link' && it.url) {
      const h = hostOf(it.url);
      if (h) hosts.add(h);
    }
  }
  const slides = new Set(
    (((state && state.wallpaper) || {}).slides || []).map((s) => 'wall.' + s.key)
  );

  let removed = 0;
  try {
    for (const row of await idbAll(STORE_ICONS)) {
      if (!hosts.has(row.key)) {
        await idbDel(STORE_ICONS, row.key);
        removed++;
      }
    }
  } catch { /* 读不到就跳过 */ }

  try {
    for (const row of await idbAll(STORE_KV)) {
      const k = String(row.key);
      if (k === 'wallpaper' || slides.has(k) || !k.startsWith('wall.')) continue;
      await idbDel(STORE_KV, k);
      removed++;
    }
  } catch { /* 读不到就跳过 */ }

  return removed;
}
