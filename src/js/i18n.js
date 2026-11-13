/* ESM 侧的薄封装：字典本体在 strings.js（经典脚本，<head> 同步加载）。
 * 这里不复制任何文案，所以 Node 测试里 t() 只是拿不到字典时回退成 key，
 * 不会把第二份中文打进包里。 */
const api = () => (typeof globalThis !== 'undefined' ? globalThis.ZL_I18N : null);

export function t(key, ...args) {
  const a = api();
  return a ? a.t(key, ...args) : key;
}

export function currentLang() {
  const a = api();
  return a ? a.lang() : 'zh_CN';
}

export function setLanguage(pref) {
  const a = api();
  return a ? a.init(pref) : 'zh_CN';
}

export function applyStaticStrings() {
  const a = api();
  if (a) a.apply();
}

/* 缺字典时也能算，给 boot 之外的调用方兜底 */
export function resolveLang(pref) {
  if (pref === 'en' || pref === 'zh_CN') return pref;
  const nav = typeof navigator !== 'undefined' ? navigator.language || '' : '';
  return /^zh/i.test(nav) ? 'zh_CN' : 'en';
}
