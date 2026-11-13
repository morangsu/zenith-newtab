/* 单位换算：长度 / 重量 / 温度，全部本地计算。 */
import { el } from '../util.js';
import { t } from '../i18n.js';

/* 只留换算系数；显示名全部走字典，语言切换后 board.render() 重挂载即可生效。 */
export const CATS = {
  length: { units: { m: { f: 1 }, km: { f: 1000 }, cm: { f: 0.01 }, mm: { f: 0.001 }, in: { f: 0.0254 }, ft: { f: 0.3048 }, mi: { f: 1609.344 } } },
  weight: { units: { kg: { f: 1 }, g: { f: 0.001 }, t: { f: 1000 }, lb: { f: 0.45359237 }, oz: { f: 0.028349523125 } } },
  temp: { units: { c: { f: 1 }, f: { f: 1 }, k: { f: 1 } } }
};

const CAT_ORDER = ['length', 'weight', 'temp'];
const NAME_KEYS = {
  length: 'w.unit.lengthUnits',
  weight: 'w.unit.weightUnits',
  temp: 'w.unit.tempUnits'
};
const list = (key) => t(key).split('|');

export function catName(cat) {
  const i = CAT_ORDER.indexOf(cat);
  return i < 0 ? cat : list('w.unit.cat')[i];
}

export function unitName(cat, unit) {
  const keys = Object.keys((CATS[cat] || {}).units || {});
  const i = keys.indexOf(unit);
  return i < 0 || !NAME_KEYS[cat] ? unit : list(NAME_KEYS[cat])[i];
}

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
  nameKey: 'widget.unit',
  cols: 2,
  rows: 1,

  mount(body, ctx) {
    const data = ctx.data({ cat: 'length', from: 'm', to: 'km', value: '1' });

    const catSel = el(
      'select',
      { class: 'w-select' },
      Object.entries(CATS).map(([k, v]) =>
        el('option', { value: k, text: catName(k), selected: k === data.cat })
      )
    );

    const fromSel = el('select', { class: 'w-select' });
    const toSel = el('select', { class: 'w-select' });
    const input = el('input', { class: 'w-input', value: data.value || '', placeholder: t('w.unit.number') });
    const out = el('div', { class: 'w-result', text: '' });

    function fillUnits() {
      fromSel.textContent = '';
      toSel.textContent = '';
      for (const [k, u] of Object.entries(CATS[data.cat].units)) {
        fromSel.append(el('option', { value: k, text: unitName(data.cat, k), selected: k === data.from }));
        toSel.append(el('option', { value: k, text: unitName(data.cat, k), selected: k === data.to }));
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
