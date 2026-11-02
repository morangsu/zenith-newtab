/* 倒计时 / 纪念日：点卡片修改名称与日期（本地存，不联网）。 */
import { el } from '../util.js';

function daysBetween(from, to) {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}

export default {
  type: 'countdown',
  name: '纪念日',
  cols: 2,
  rows: 1,

  mount(body, ctx) {
    const data = ctx.data({ label: '我的生日', date: '' });
    const box = el('div', { class: 'w-count' });

    function paint() {
      box.textContent = '';
      if (!data.date) {
        box.append(el('div', { class: 'w-empty', text: '点击设置日期' }));
        return;
      }
      const target = new Date(data.date + 'T00:00:00');
      if (Number.isNaN(target.getTime())) {
        box.append(el('div', { class: 'w-empty', text: '日期格式不对' }));
        return;
      }
      const diff = daysBetween(new Date(), target);
      /* 说明并成一行：2×1 的卡片放不下「数字 + 两行小字」 */
      const tail =
        diff === 0 ? '就是今天 · ' : diff < 0 ? `已经 ${-diff} 天 · ` : `还有 ${diff} 天 · `;
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
      const label = window.prompt('名称', data.label || '纪念日');
      if (label === null) return;
      const date = window.prompt('日期（YYYY-MM-DD）', data.date || '2000-01-01');
      if (date === null) return;
      data.label = label.trim() || '纪念日';
      data.date = date.trim();
      ctx.save();
      paint();
    });

    body.append(box);
    paint();
  }
};
