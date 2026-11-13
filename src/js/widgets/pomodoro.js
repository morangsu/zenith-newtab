/* 番茄钟：用结束时间戳计时，页面被切走再回来也不会走偏。
   工作/休息时长可由「组件设置」统一配置，也可在卡片「时长」里单独改。 */
import { el } from '../util.js';
import { t } from '../i18n.js';
import { onTick } from '../ticker.js';

const MAX_MIN = 180;

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function clampMin(v, fallback) {
  v = Math.round(Number(v));
  if (!Number.isFinite(v)) return fallback;
  return Math.min(MAX_MIN, Math.max(1, v));
}

export default {
  type: 'pomodoro',
  nameKey: 'widget.pomodoro',
  cols: 2,
  rows: 1,

  mount(body, ctx) {
    /* 协议化的默认值：schema 在 config.js 里声明，设置面板统一渲染 */
    const cfg = ctx.config ? ctx.config('pomodoro') : { focusMin: 25, breakMin: 5 };
    const data = ctx.data({
      endsAt: 0,
      remain: clampMin(cfg.focusMin, 25) * 60,
      running: false,
      phase: 'focus',
      focusMin: clampMin(cfg.focusMin, 25),
      breakMin: clampMin(cfg.breakMin, 5)
    });
    data.focusMin = clampMin(data.focusMin, 25);
    data.breakMin = clampMin(data.breakMin, 5);
    if (data.phase !== 'break') data.phase = 'focus';

    const dur = () => (data.phase === 'break' ? data.breakMin : data.focusMin) * 60;

    const time = el('div', { class: 'w-time', text: fmt(data.remain) });
    const phase = el('span', { class: 'w-pomo-phase' });
    const start = el('button', { class: 'btn tiny primary', type: 'button', text: t('w.pomo.start') });
    const reset = el('button', { class: 'btn tiny', type: 'button', text: t('w.pomo.reset') });
    const gear = el('button', {
      class: 'btn tiny',
      type: 'button',
      text: t('w.pomo.duration'),
      title: t('w.pomo.durationTitle')
    });

    function paint() {
      if (data.running) {
        const left = Math.max(0, Math.round((data.endsAt - Date.now()) / 1000));
        data.remain = left;
        if (left === 0) {
          data.running = false;
          ctx.save();
        }
      }
      phase.textContent = t(data.phase === 'break' ? 'w.pomo.break' : 'w.pomo.focus');
      time.textContent = fmt(data.remain);
      time.classList.toggle('done', !data.running && data.remain === 0);
      start.textContent = t(data.running ? 'w.pomo.pause' : data.remain === 0 ? 'w.pomo.next' : 'w.pomo.start');
    }

    start.addEventListener('click', () => {
      if (data.running) {
        data.running = false;
      } else if (data.remain > 0) {
        data.endsAt = Date.now() + data.remain * 1000;
        data.running = true;
      } else {
        /* 一个阶段结束：进入下一个阶段 */
        data.phase = data.phase === 'break' ? 'focus' : 'break';
        data.remain = dur();
        data.endsAt = Date.now() + data.remain * 1000;
        data.running = true;
      }
      ctx.save();
      paint();
    });

    reset.addEventListener('click', () => {
      data.running = false;
      data.phase = 'focus';
      data.remain = data.focusMin * 60;
      ctx.save();
      paint();
    });

    /* ---------- 时长设置弹层 ---------- */
    let pop = null;
    function closePop() {
      if (pop) {
        pop.remove();
        pop = null;
        document.removeEventListener('pointerdown', onDocDown, true);
        document.removeEventListener('keydown', onDocKey, true);
      }
    }
    function onDocDown(e) {
      if (pop && !pop.contains(e.target)) closePop();
    }
    function onDocKey(e) {
      if (e.key === 'Escape') closePop();
    }
    function openPop() {
      if (pop) return closePop();
      const focusIn = el('input', {
        type: 'number',
        min: '1',
        max: String(MAX_MIN),
        value: String(data.focusMin),
        'aria-label': t('w.pomo.focusAria')
      });
      const breakIn = el('input', {
        type: 'number',
        min: '1',
        max: String(MAX_MIN),
        value: String(data.breakMin),
        'aria-label': t('w.pomo.breakAria')
      });
      const apply = el('button', { class: 'btn tiny primary', type: 'button', text: t('w.pomo.apply') });

      apply.addEventListener('click', () => {
        data.focusMin = clampMin(focusIn.value, data.focusMin);
        data.breakMin = clampMin(breakIn.value, data.breakMin);
        if (!data.running) data.remain = dur();
        ctx.save();
        paint();
        closePop();
      });
      focusIn.addEventListener('keydown', (e) => e.key === 'Enter' && apply.click());
      breakIn.addEventListener('keydown', (e) => e.key === 'Enter' && apply.click());

      pop = el(
        'div',
        { class: 'w-pomo-pop' },
        el('label', {}, [el('span', { text: t('w.pomo.focusLabel') }), focusIn]),
        el('label', {}, [el('span', { text: t('w.pomo.breakLabel') }), breakIn]),
        apply
      );
      /* 挂在卡片节点上：card-body 是滚动容器，会裁掉绝对定位的弹层 */
      (body.parentElement || body).append(pop);
      document.addEventListener('pointerdown', onDocDown, true);
      document.addEventListener('keydown', onDocKey, true);
      focusIn.focus();
      focusIn.select();
    }
    gear.addEventListener('click', openPop);

    const off = onTick(paint);
    body.append(
      el('div', { class: 'w-pomo-top' }, time, phase),
      el('div', { class: 'w-row' }, start, reset, gear)
    );
    paint();
    return () => {
      off();
      closePop();
    };
  }
};
