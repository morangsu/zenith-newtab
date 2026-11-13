/* 本地历史快照：把「本地优先」变成可回溯的，而不是只有一份当前状态。
 * 只存状态树（含用户上传的内联图标），不存壁纸与站点图标缓存——那些是二进制，
 * 体积大且恢复时本来就该沿用本机现有的。快照全在 IndexedDB，永不联网。 */
import { idbAll, idbGet, idbPut, idbDel, STORE_SNAPS } from './idb.js';
import { canonical, sha256Hex } from './hash.js';

export const SNAP_LIMIT = 20;

/* 状态里只挑这些字段：UI 临时字段、运行时缓存都不进快照 */
export const SNAP_FIELDS = [
  'v', 'theme', 'ui', 'wallpaper', 'engine', 'items', 'widgetData', 'widgetConfig', 'syncByType'
];

export function snapshotState(state) {
  const out = {};
  for (const k of SNAP_FIELDS) if (state[k] !== undefined) out[k] = state[k];
  return JSON.parse(JSON.stringify(out));
}

export function countOf(snap) {
  return (Array.isArray(snap.items) ? snap.items.length : 0) +
    (snap.widgetData && typeof snap.widgetData === 'object' ? Object.keys(snap.widgetData).length : 0);
}

export async function listSnapshots() {
  try {
    const rows = await idbAll(STORE_SNAPS);
    return rows
      .map((r) => ({
        ts: Number(r.key),
        reason: (r.value && r.value.reason) || 'auto',
        hash: (r.value && r.value.hash) || '',
        count: (r.value && r.value.count) || 0
      }))
      .sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}

/* 同一状态不重复存；超过上限删最旧的。返回是否真的写了一份。 */
export async function takeSnapshot(state, reason = 'auto') {
  const snap = snapshotState(state);
  const hash = await sha256Hex(canonical(snap));
  const rows = await listSnapshots();
  if (rows.length && rows[0].hash === hash) return { created: false, hash };

  const used = new Set(rows.map((r) => String(r.ts)));
  let ts = Date.now();
  while (used.has(String(ts))) ts++;
  await idbPut(STORE_SNAPS, String(ts), {
    ts, reason, hash, count: countOf(snap), state: snap
  });

  const after = await listSnapshots();
  for (const r of after.slice(SNAP_LIMIT)) await idbDel(STORE_SNAPS, String(r.ts));
  return { created: true, hash, ts };
}

export async function readSnapshot(ts) {
  const row = await idbGet(STORE_SNAPS, String(ts));
  return row && row.state ? row : null;
}

/* 恢复前先留一份当前状态（reason=manual），保证回滚本身也能再回滚。 */
export async function restoreSnapshot(ts, currentState) {
  const row = await readSnapshot(ts);
  if (!row) return null;
  await takeSnapshot(currentState, 'manual');
  return row.state;
}

export async function deleteSnapshot(ts) {
  await idbDel(STORE_SNAPS, String(ts));
}

export async function clearSnapshots() {
  for (const r of await listSnapshots()) await idbDel(STORE_SNAPS, String(r.ts));
}
