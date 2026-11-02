/* 待办：回车添加，点复选框完成，× 删除。数据存在卡片自己的 widgetData 里。 */
import { el } from '../util.js';

export default {
  type: 'todo',
  name: '待办',
  cols: 4,
  rows: 1,

  mount(body, ctx) {
    const data = ctx.data({ items: [] });
    const list = el('ul', { class: 'w-todo' });
    const input = el('input', { class: 'w-input', placeholder: '添加待办，回车确认' });

    function paint() {
      list.textContent = '';
      const items = data.items || [];
      if (!items.length) {
        list.append(el('li', { class: 'w-empty', text: '还没有待办' }));
        return;
      }
      for (const item of items) {
        const li = el(
          'li',
          { class: item.done ? 'done' : '' },
          el('input', {
            type: 'checkbox',
            checked: !!item.done,
            onchange: () => {
              item.done = !item.done;
              ctx.save();
              li.classList.toggle('done', item.done);
            }
          }),
          el('span', { class: 'w-text', text: item.text }),
          el('button', {
            class: 'w-x',
            type: 'button',
            text: '×',
            title: '删除',
            onclick: () => {
              data.items = items.filter((x) => x !== item);
              ctx.save();
              paint();
            }
          })
        );
        list.append(li);
      }
    }

    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const text = input.value.trim();
      if (!text) return;
      if (!Array.isArray(data.items)) data.items = [];
      data.items.push({ text, done: false });
      input.value = '';
      ctx.save();
      paint();
    });

    body.append(el('div', { class: 'w-col' }, list, input));
    paint();
  }
};
