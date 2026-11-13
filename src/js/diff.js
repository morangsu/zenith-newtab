/* 同步差异描述：纯函数，用来回答「这次同步到底会改我什么」。
 * 不做合并、不写状态，只比较两份配置快照，输出结构化差异。 */
import { canonical } from './hash.js';

const FIELDS = ['theme', 'ui', 'wallpaper', 'engine', 'items', 'widgetData', 'widgetConfig'];

const keyMap = (arr) => {
  const m = new Map();
  for (const it of Array.isArray(arr) ? arr : []) {
    if (it && it.id) m.set(it.id, it);
  }
  return m;
};

/* wallpaper.slides 只存本机图片键，同步时会被剔除，比较前先无视它 */
function cleanField(name, value) {
  if (name === 'wallpaper' && value && typeof value === 'object') {
    const copy = { ...value };
    delete copy.slides;
    return copy;
  }
  return value;
}

export function diffConfigs(localCfg, remoteCfg) {
  const a = localCfg || {};
  const b = remoteCfg || {};
  const changed = [];
  for (const k of FIELDS) {
    if (canonical(cleanField(k, a[k])) !== canonical(cleanField(k, b[k]))) changed.push(k);
  }

  const la = keyMap(a.items);
  const lb = keyMap(b.items);
  let added = 0;
  let removed = 0;
  let itemsChanged = 0;
  for (const [id, it] of lb) {
    if (!la.has(id)) added++;
    else if (canonical(la.get(id)) !== canonical(it)) itemsChanged++;
  }
  for (const id of la.keys()) if (!lb.has(id)) removed++;

  const wa = (a.widgetData && typeof a.widgetData === 'object') ? a.widgetData : {};
  const wb = (b.widgetData && typeof b.widgetData === 'object') ? b.widgetData : {};
  const ids = new Set([...Object.keys(wa), ...Object.keys(wb)]);
  let widgetChanges = 0;
  for (const id of ids) if (canonical(wa[id]) !== canonical(wb[id])) widgetChanges++;

  return {
    changed,
    added,
    removed,
    itemsChanged,
    widgetChanges,
    empty: changed.length === 0 && !added && !removed && !itemsChanged && !widgetChanges
  };
}

/* 给 UI 用的一句话摘要。t 由调用方注入，保证这个模块本身不依赖 DOM。 */
export function formatDiff(diff, t) {
  if (!diff) return '';
  if (diff.empty) return t('sync.noChanges');
  const parts = [t('sync.diffFields', diff.changed.length, diff.added, diff.widgetChanges)];
  if (diff.added || diff.removed || diff.itemsChanged) {
    parts.push('+' + diff.added + ' / −' + diff.removed + ' / ~' + diff.itemsChanged);
  }
  return parts.join('　');
}
