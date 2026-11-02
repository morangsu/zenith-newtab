/* 月历：当月网格 + 今天高亮 + 今天的农历。左右箭头翻月。 */
import { el } from '../util.js';
import { lunarText } from '../lunar.js';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

export default {
  type: 'calendar',
  name: '月历',
  cols: 2,
  rows: 2,

  mount(body, ctx) {
    const data = ctx.data({ offset: 0 });
    const root = el('div', { class: 'w-cal' });

    function paint() {
      root.textContent = '';
      const now = new Date();
      const base = new Date(now.getFullYear(), now.getMonth() + (data.offset || 0), 1);
      const year = base.getFullYear();
      const month = base.getMonth();

      const head = el(
        'div',
        { class: 'cal-head' },
        el('button', {
          class: 'cal-nav',
          type: 'button',
          text: '‹',
          onclick: () => {
            data.offset = (data.offset || 0) - 1;
            ctx.save();
            paint();
          }
        }),
        el('span', { class: 'cal-title', text: `${year}年${month + 1}月` }),
        el('button', {
          class: 'cal-nav',
          type: 'button',
          text: '›',
          onclick: () => {
            data.offset = (data.offset || 0) + 1;
            ctx.save();
            paint();
          }
        })
      );

      const week = el('div', { class: 'cal-week' }, WEEK.map((w) => el('span', { text: w })));
      const grid = el('div', { class: 'cal-grid' });

      const firstWeekday = new Date(year, month, 1).getDay();
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const todayKey =
        now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate();

      for (let i = 0; i < firstWeekday; i++) grid.append(el('span', { class: 'cal-blank' }));
      for (let d = 1; d <= daysInMonth; d++) {
        const isToday = `${year}-${month}-${d}` === todayKey;
        grid.append(el('span', { class: isToday ? 'cal-day today' : 'cal-day', text: String(d) }));
      }

      const foot = el('div', { class: 'cal-foot', text: `${lunarText(now)}` });

      root.append(head, week, grid, foot);
    }

    body.append(root);
    paint();
  }
};
