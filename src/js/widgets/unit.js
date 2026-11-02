/* 单位换算：长度 / 重量 / 温度，全部本地计算。 */
import { el } from '../util.js';

export const CATS = {
  length: {
    name: '长度',
    units: {
      m: { name: '米', f: 1 },
      km: { name: '千米', f: 1000 },
      cm: { name: '厘米', f: 0.01 },
      mm: { name: '毫米', f: 0.001 },
      in: { name: '英寸', f: 0.0254 },
      ft: { name: '英尺', f: 0.3048 },
      mi: { name: '英里', f: 1609.344 }
    }
  },
  weight: {
    name: '重量',
    units: {
      kg: { name: '千克', f: 1 },
      g: { name: '克', f: 0.001 },
      t: { name: '吨', f: 1000 },
      lb: { name: '磅', f: 0.45359237 },
      oz: { name: '盎司', f: 0.028349523125 }
    }
  },
  temp: {
    name: '温度',
    units: {
      c: { name: '摄氏度', f: 1 },
      f: { name: '华氏度', f: 1 },
      k: { name: '开尔文', f: 1 }
    }
  }
};

export function convert(cat, from, to, value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;

  if (cat === 'temp') {
    const celsius = from === 'c' ? v : from === 'f' ? ((v - 32) * 5) / 9 : v - 273.15;
    if (to === 'c') return celsius;
    if (to === 'f') return (celsius * 9) / 5 + 32;
    return celsius + 273.15;
  }

  const group = CATS[cat];
  if (!group || !group.units[from] || !group.units[to]) return null;
  return (v * group.units[from].f) / group.units[to].f;
}

function trim(n) {
  if (n === null) return '';
  const r = Math.round(n * 1e6) / 1e6;
  return String(r);
}

export default {
  type: 'unit',
  name: '单位换算',
  cols: 2,
  rows: 1,

  mount(body, ctx) {
    const data = ctx.data({ cat: 'length', from: 'm', to: 'km', value: '1' });

    const catSel = el(
      'select',
      { class: 'w-select' },
      Object.entries(CATS).map(([k, v]) =>
        el('option', { value: k, text: v.name, selected: k === data.cat })
      )
    );

    const fromSel = el('select', { class: 'w-select' });
    const toSel = el('select', { class: 'w-select' });
    const input = el('input', { class: 'w-input', value: data.value || '', placeholder: '数值' });
    const out = el('div', { class: 'w-result', text: '' });

    function fillUnits() {
      fromSel.textContent = '';
      toSel.textContent = '';
      for (const [k, u] of Object.entries(CATS[data.cat].units)) {
        fromSel.append(el('option', { value: k, text: u.name, selected: k === data.from }));
        toSel.append(el('option', { value: k, text: u.name, selected: k === data.to }));
      }
    }

    function run() {
      const v = convert(data.cat, data.from, data.to, input.value);
      out.textContent = trim(v) || '—';
      ctx.save();
    }

    catSel.addEventListener('change', () => {
      data.cat = catSel.value;
      const keys = Object.keys(CATS[data.cat].units);
      data.from = keys[0];
      data.to = keys[1] || keys[0];
      fillUnits();
      run();
    });
    fromSel.addEventListener('change', () => {
      data.from = fromSel.value;
      run();
    });
    toSel.addEventListener('change', () => {
      data.to = toSel.value;
      run();
    });
    input.addEventListener('input', () => {
      data.value = input.value;
      run();
    });

    body.append(
      el('div', { class: 'w-row' }, catSel),
      el('div', { class: 'w-row' }, fromSel, el('span', { class: 'w-arrow', text: '→' }), toSel),
      input,
      out
    );

    fillUnits();
    run();
  }
};
