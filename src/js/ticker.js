/* 全局心跳：所有需要按秒刷新的组件共用一个定时器，避免 N 个 setInterval。
   页面隐藏时暂停，回来后立刻补一次。 */
const subs = new Set();
let timer = 0;
let bound = false;

function fire() {
  const now = new Date();
  for (const fn of subs) {
    try {
      fn(now);
    } catch {
      /* 单个组件出错不影响其它组件 */
    }
  }
}

function schedule() {
  const delay = 1000 - (Date.now() % 1000);
  timer = setTimeout(() => {
    if (!document.hidden) fire();
    schedule();
  }, delay + 4);
}

export function onTick(fn) {
  subs.add(fn);
  if (!bound) {
    bound = true;
    fire();
    schedule();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) fire();
    });
  }
  return () => subs.delete(fn);
}
