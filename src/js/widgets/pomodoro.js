/* 番茄钟：用结束时间戳计时，页面被切走再回来也不会走偏。 */
import { el } from '../util.js';
import { onTick } from '../ticker.js';

const FOCUS = 25 * 60;

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

export default {
  type: 'pomodoro',
  name: '番茄钟',
  cols: 2,
  rows: 1,

  mount(body, ctx) {
    const data = ctx.data({ endsAt: 0, remain: FOCUS, running: false });
    const time = el('div', { class: 'w-time', text: fmt(data.remain) });
    const start = el('button', { class: 'btn tiny primary', type: 'button', text: '开始' });
    const reset = el('button', { class: 'btn tiny', type: 'button', text: '重置' });

    function paint() {
      if (data.running) {
        const left = Math.max(0, Math.round((data.endsAt - Date.now()) / 1000));
        data.remain = left;
        if (left === 0) {
          data.running = false;
          ctx.save();
        }
      }
      time.textContent = fmt(data.remain);
      time.classList.toggle('done', !data.running && data.remain === 0);
      start.textContent = data.running ? '暂停' : data.remain === 0 ? '再来' : '开始';
    }

    start.addEventListener('click', () => {
      if (data.running) {
        data.running = false;
      } else {
        if (!data.remain) data.remain = FOCUS;
        data.endsAt = Date.now() + data.remain * 1000;
        data.running = true;
      }
      ctx.save();
      paint();
    });

    reset.addEventListener('click', () => {
      data.running = false;
      data.remain = FOCUS;
      ctx.save();
      paint();
    });

    body.append(time, el('div', { class: 'w-row' }, start, reset));
    const off = onTick(paint);
    paint();
    return off;
  }
};
