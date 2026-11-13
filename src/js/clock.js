/* 时钟：对齐到整秒刷新，标签页不可见时停掉定时器。 */
import { lunarText } from './lunar.js';
import { t } from './i18n.js';

const WEEK = () => t('w.clock.week').split(' ');
const pad = (n) => (n < 10 ? '0' + n : String(n));

export function startClock(root) {
  const tEl = root.querySelector('#clock-time');
  const dEl = root.querySelector('#clock-date');
  const lEl = root.querySelector('#clock-lunar');

  let timer = 0;
  let lastSecond = '';
  let lastDay = '';

  function paint() {
    const now = new Date();
    const hh = pad(now.getHours());
    const mm = pad(now.getMinutes());
    const ss = pad(now.getSeconds());
    const secKey = hh + mm + ss;

    if (secKey !== lastSecond) {
      lastSecond = secKey;
      tEl.textContent = `${hh}:${mm}:${ss}`;
    }

    const dayKey = now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate();
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      dEl.textContent =
        t('w.clock.date', now.getMonth() + 1, now.getDate(), WEEK()[now.getDay()]);
      lEl.textContent = lunarText(now);
    }
  }

  function schedule() {
    const delay = 1000 - (Date.now() % 1000);
    timer = setTimeout(() => {
      paint();
      schedule();
    }, delay + 4);
  }

  paint();
  schedule();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(timer);
      timer = 0;
    } else {
      paint();
      lastSecond = '';
      if (!timer) schedule();
    }
  });

  return () => clearTimeout(timer);
}
