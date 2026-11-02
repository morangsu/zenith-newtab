/* 通用小工具：只放无副作用的纯函数，方便在 Node 里直接单测。 */

export const IS_FIREFOX =
  typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent);

export const ext =
  (typeof globalThis !== 'undefined' && (globalThis.browser || globalThis.chrome)) || null;

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function looksLikeUrl(text) {
  const s = text.trim();
  if (!s || /\s/.test(s)) return false;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(s);
}

export function normalizeUrl(text) {
  const s = text.trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (/^(mailto|tel):/i.test(s)) return s;
  return 'https://' + s.replace(/^\/+/, '');
}

export function initialOf(text) {
  const s = (text || '').trim();
  if (!s) return '·';
  const ch = Array.from(s)[0];
  return /[a-z]/i.test(ch) ? ch.toUpperCase() : ch;
}

/* 稳定的色相，保证同一个站点每次都是同一个颜色 */
export function hueOf(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
  return h;
}

export function debounce(fn, ms) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* 建 DOM 的小工具：属性直接赋值，on* 走事件监听，字符串当文本节点 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(typeof c === 'string' || typeof c === 'number' ? String(c) : c);
  }
  return node;
}

/* 子序列匹配：q 的字符按顺序出现在 text 中即算命中，返回匹配紧密度 */
export function subseqScore(text, q) {
  const t = text.toLowerCase();
  const s = q.toLowerCase();
  if (!s) return 0;
  if (t.startsWith(s)) return 100;
  const idx = t.indexOf(s);
  if (idx > 0) return 70 - Math.min(idx, 20);
  let ti = 0;
  let hit = 0;
  for (const ch of s) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return 0;
    hit += found === ti ? 2 : 1;
    ti = found + 1;
  }
  return 20 + Math.min(hit, 15);
}

/* 背景有多亮 → 该用深色文字还是浅色文字（'dark' 表示深色方案：浅色文字 + 深色卡片）。
   不设固定阈值：按与纯黑/纯白的 WCAG 对比度取大的那边，中灰附近也不会两边都勉强。 */
export function pickTone(luminance) {
  const L = Math.min(1, Math.max(0, Number(luminance) || 0));
  const withWhite = 1.05 / (L + 0.05);
  const withBlack = (L + 0.05) / 0.05;
  return withWhite >= withBlack ? 'dark' : 'light';
}
