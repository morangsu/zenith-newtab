/* 搜索：只用本地数据（收藏的站点 + 可选的书签），不做任何联想请求。
   回车逻辑——看起来像网址就直接打开，否则用当前搜索引擎跳转。 */
import { subseqScore, looksLikeUrl, normalizeUrl, hostOf } from './util.js';

export const ENGINES = [
  { id: 'bing', name: '必应', url: 'https://www.bing.com/search?q=%s' },
  { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd=%s' },
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s' },
  { id: 'ddg', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' }
];

export function engineById(id) {
  return ENGINES.find((e) => e.id === id) || ENGINES[0];
}

export function buildUrlForQuery(engineId, text) {
  const q = text.trim();
  if (!q) return '';
  if (looksLikeUrl(q)) return normalizeUrl(q);
  return engineById(engineId).url.replace('%s', encodeURIComponent(q));
}

/** 在本地候选里打分排序；candidates: [{title,url,kind}] */
export function matchLocal(query, candidates, limit = 8) {
  const q = query.trim();
  if (!q) return [];
  const scored = [];
  for (const c of candidates) {
    const byTitle = subseqScore(c.title || '', q);
    const byHostRaw = subseqScore(hostOf(c.url) || '', q);
    const byUrlRaw = subseqScore(c.url || '', q);
    if (!byTitle && !byHostRaw && !byUrlRaw) continue;
    const best = Math.max(
      byTitle,
      byHostRaw ? byHostRaw + 6 : 0,
      byUrlRaw ? byUrlRaw - 10 : 0
    );
    if (best > 0) scored.push({ ...c, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function createSearch({ getEngineId, getCandidates, onNavigate }) {
  const input = document.getElementById('search-input');
  const suggest = document.getElementById('suggest');
  const engineBtn = document.getElementById('engine-btn');

  let rows = [];
  let active = -1;

  function close() {
    suggest.hidden = true;
    suggest.textContent = '';
    rows = [];
    active = -1;
  }

  function paint() {
    suggest.textContent = '';
    if (!rows.length) {
      close();
      return;
    }
    rows.forEach((row, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));

      const title = document.createElement('span');
      title.className = 's-title';
      title.textContent = row.title;

      const kind = document.createElement('span');
      kind.className = 's-kind';
      kind.textContent = row.kind;

      li.append(title, kind);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        onNavigate(row.url);
      });
      suggest.append(li);
    });
    suggest.hidden = false;
  }

  function refresh() {
    const q = input.value;
    if (!q.trim()) {
      close();
      return;
    }
    rows = matchLocal(q, getCandidates());
    active = rows.length ? 0 : -1;
    paint();
  }

  function move(delta) {
    if (!rows.length) return;
    active = (active + delta + rows.length) % rows.length;
    Array.from(suggest.children).forEach((el, i) =>
      el.setAttribute('aria-selected', String(i === active))
    );
  }

  function submit() {
    if (active >= 0 && rows[active]) {
      onNavigate(rows[active].url);
      return;
    }
    const url = buildUrlForQuery(getEngineId(), input.value);
    if (url) onNavigate(url);
  }

  input.addEventListener('input', refresh);
  input.addEventListener('focus', refresh);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      input.blur();
      close();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || document.activeElement === input) return;
    if (input.offsetParent === null) return; // 搜索栏被关掉时不抢快捷键
    e.preventDefault();
    input.focus();
    input.select();
  });

  document.addEventListener('click', (e) => {
    if (!suggest.hidden && !suggest.contains(e.target) && e.target !== input) close();
  });

  engineBtn.addEventListener('click', () => {
    const idx = ENGINES.findIndex((x) => x.id === getEngineId());
    const next = ENGINES[(idx + 1) % ENGINES.length];
    engineBtn.textContent = next.name;
    engineBtn.dataset.engine = next.id;
    onNavigate(null, next.id);
  });

  return {
    setEngine(id) {
      engineBtn.textContent = engineById(id).name;
      engineBtn.dataset.engine = engineById(id).id;
    },
    focus() {
      input.focus();
    }
  };
}
