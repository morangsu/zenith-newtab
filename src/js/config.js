/* 组件配置协议：组件只声明「有哪些可配项」，设置面板统一渲染，
 * 以后加组件不用再改 settings.js。
 *
 * 两层语义：
 *   state.widgetConfig[type]  —— 该类型的默认值，新组件 mount 时读它
 *   state.widgetData[id]      —— 单个实例的数据，组件自己也能改（如卡片里的「时长」）
 * 在面板里改默认值会同时刷新已有实例，避免出现「改了没反应」。 */
import { t } from './i18n.js';

export const SCHEMAS = {
  pomodoro: [
    { key: 'focusMin', label: 'cfg.focusMin', min: 1, max: 180, def: 25 },
    { key: 'breakMin', label: 'cfg.breakMin', min: 1, max: 180, def: 5 }
  ]
};

export const CONFIGURABLE = Object.keys(SCHEMAS);

export function clampField(value, field) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return field.def;
  return Math.min(field.max, Math.max(field.min, n));
}

/* 读某类型的默认值；没存过就用 schema 里的 def。纯函数，可单测。 */
export function configFor(state, type) {
  const fields = SCHEMAS[type];
  if (!fields) return {};
  const saved = (state && state.widgetConfig && state.widgetConfig[type]) || {};
  const out = {};
  for (const f of fields) out[f.key] = clampField(saved[f.key] ?? f.def, f);
  return out;
}

/* 写入默认值 + 同步刷新该类型已有实例。直接改传入的 state（由 store.commit 调用）。 */
export function saveConfig(state, type, values) {
  const fields = SCHEMAS[type];
  if (!fields) return false;
  const next = {};
  for (const f of fields) next[f.key] = clampField(values[f.key], f);
  state.widgetConfig = state.widgetConfig || {};
  state.widgetConfig[type] = next;

  if (Array.isArray(state.items) && state.widgetData) {
    for (const it of state.items) {
      if (it && it.kind === 'widget' && it.type === type && state.widgetData[it.id]) {
        Object.assign(state.widgetData[it.id], next);
      }
    }
  }
  return true;
}

export function validateConfig(type, values) {
  const fields = SCHEMAS[type];
  if (!fields) return null;
  const out = {};
  for (const f of fields) out[f.key] = clampField(values && values[f.key], f);
  return out;
}

/* 设置面板里的统一渲染器：h 是 settings.js 的元素工厂，commit 是 store.commit。 */
export function renderConfigSection(h, state, commit, onApplied) {
  const blocks = [];
  for (const type of CONFIGURABLE) {
    const fields = SCHEMAS[type];
    const current = configFor(state, type);
    const inputs = {};
    const rows = fields.map((f) => {
      const input = h('input', {
        type: 'number',
        min: String(f.min),
        max: String(f.max),
        value: String(current[f.key])
      });
      inputs[f.key] = input;
      return h('div', { class: 'row' }, [
        h('span', { class: 'lbl', text: t(f.label) }),
        input
      ]);
    });
    const btn = h('button', {
      class: 'btn',
      type: 'button',
      text: t('cfg.save'),
      onclick: () => {
        const values = {};
        for (const f of fields) values[f.key] = inputs[f.key].value;
        commit((s) => saveConfig(s, type, values));
        btn.textContent = t('cfg.saved');
        if (onApplied) onApplied();
      }
    });
    blocks.push(
      h('div', { class: 'cfg-block' }, [
        h('h4', { text: t('widget.' + type) }),
        ...rows,
        h('div', { class: 'row' }, [btn])
      ])
    );
  }
  return h('section', { class: 'sec' }, [
    h('h3', { text: t('sec.widgets') }),
    ...blocks,
    h('p', { class: 'hint-text', text: t('cfg.hint') })
  ]);
}
