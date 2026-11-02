/* 组件注册表：每个组件一个模块，默认导出一个描述对象。
   mount(body, ctx) 里自行创建 DOM；返回的函数会在卡片销毁时调用。 */

import todo from './widgets/todo.js';
import countdown from './widgets/countdown.js';
import calendar from './widgets/calendar.js';
import pomodoro from './widgets/pomodoro.js';
import notes from './widgets/notes.js';
import calculator from './widgets/calculator.js';
import money from './widgets/money.js';
import unit from './widgets/unit.js';

export const WIDGETS = [todo, countdown, calendar, pomodoro, notes, calculator, money, unit];

const byType = new Map(WIDGETS.map((w) => [w.type, w]));

export function widgetByType(type) {
  return byType.get(type) || WIDGETS[0];
}
