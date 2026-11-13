/* 便签：输入即存（防抖 400ms），关掉页面也不丢。 */
import { el } from '../util.js';
import { t } from '../i18n.js';

export default {
  type: 'notes',
  nameKey: 'widget.notes',
  cols: 2,
  rows: 1,

  mount(body, ctx) {
    const data = ctx.data({ text: '' });
    const area = el('textarea', {
      class: 'w-notes',
      placeholder: t('w.notes.placeholder'),
      value: data.text || ''
    });

    let timer = 0;
    area.addEventListener('input', () => {
      data.text = area.value;
      clearTimeout(timer);
      timer = setTimeout(() => ctx.save(), 400);
    });

    body.append(area);
    return () => {
      clearTimeout(timer);
      ctx.save();
    };
  }
};
