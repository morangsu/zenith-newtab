/* 倒计时 / 纪念日：点卡片修改名称与日期（本地存，不联网）。 */
import { el } from '../util.js';
import { t } from '../i18n.js';

function daysBetween(from, to) {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}

export default {
  type: 'countdown',
  nameKey: 'widget.countdown',
  cols: 2,
  rows: 1,

  mount(body, ctx) {
    const data = ctx.data({ label: t('w.count.defaultLabel'), date: '' });
    const box = el('div', { class: 'w-count' });

    function paint() {
      box.textContent = '';
      if (!data.date) {
        box.append(el('div', { class: 'w-empty', text: t('w.count.setDate') }));
        return;
      }
      const target = new Date(data.date + 'T00:00:00');
      if (Number.isNaN(target.getTime())) {
        box.append(el('div', { class: 'w-empty', text: t('w.count.badDate') }));
        return;
      }
      const diff = daysBetween(new Date(), target);
      /* 说明并成一行：2×1 的卡片放不下「数字 + 两行小字」 */
      const tail =
        diff === 0 ? t('w.count.today') : diff < 0 ? t('w.count.past', -diff) : t('w.count.future', diff);
      box.append(
        el('div', { class: 'w-num', text: String(Math.abs(diff)) }),
        el(
          'div',
          { class: 'w-sub' },
          tail,
          el('span', { class: 'w-sub dim', text: data.label })
        )
      );
    }

    box.addEventListener('click', () => {
      const label = window.prompt(t('w.count.promptLabel'), data.label || t('widget.countdown'));
      if (label === null) return;
      const date = window.prompt(t('w.count.promptDate'), data.date || '2000-01-01');
      if (date === null) return;
      data.label = label.trim() || t('widget.countdown');
      data.date = date.trim();
      ctx.save();
      paint();
    });

    body.append(box);
    paint();
  }
};
