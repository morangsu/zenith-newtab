/* 计算器：手写递归下降解析，不用 eval、不用 Function（CSP 也不允许）。
   支持 + - * / 与括号、小数、一元正负号。 */
import { el } from '../util.js';

export function evaluate(src) {
  const s = String(src).replace(/\s+/g, '');
  if (!s) return null;

  let i = 0;
  const peek = () => s[i];

  function primary() {
    if (peek() === '(') {
      i++;
      const v = expression();
      if (v === null || s[i] !== ')') return null;
      i++;
      return v;
    }
    const m = /^\d*\.?\d+/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  }

  function unary() {
    if (peek() === '-') {
      i++;
      const v = unary();
      return v === null ? null : -v;
    }
    if (peek() === '+') {
      i++;
      return unary();
    }
    return primary();
  }

  function term() {
    let v = unary();
    if (v === null) return null;
    while (peek() === '*' || peek() === '/') {
      const op = s[i++];
      const r = unary();
      if (r === null) return null;
      if (op === '/' && r === 0) return null;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }

  function expression() {
    let v = term();
    if (v === null) return null;
    while (peek() === '+' || peek() === '-') {
      const op = s[i++];
      const r = term();
      if (r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }

  const out = expression();
  if (out === null || i !== s.length) return null;
  return Number.isFinite(out) ? out : null;
}

export function formatNumber(n) {
  if (n === null || n === undefined) return '';
  const rounded = Math.round(n * 1e10) / 1e10;
  return String(rounded);
}

export default {
  type: 'calculator',
  name: '计算器',
  cols: 2,
  rows: 1,

  mount(body, ctx) {
    const data = ctx.data({ expr: '' });
    const input = el('input', {
      class: 'w-input calc-in',
      placeholder: '1+2*3',
      value: data.expr || '',
      spellcheck: false
    });
    const out = el('div', { class: 'w-result', text: '—' });

    function run() {
      data.expr = input.value;
      const v = evaluate(input.value);
      out.textContent = input.value.trim() ? formatNumber(v) || '—' : '—';
      ctx.save();
    }

    input.addEventListener('input', run);
    body.append(input, out);
    if (data.expr) {
      const v = evaluate(data.expr);
      out.textContent = formatNumber(v) || '—';
    }
  }
};
