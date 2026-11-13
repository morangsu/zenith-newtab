/* 界面文案字典 · 首屏核心（经典脚本，<head> 同步加载）。
 *
 * 这里只放首屏真正会用到的 key：HTML 静态文案、看板交互、组件名、
 * 默认三个组件的文字。设置面板与其余组件的文案在 strings-extra.js，
 * 由 main.js 在空闲时（或打开设置时）extend 进来 —— 首屏不必解析
 * 一大段只有点开面板才用得上的长文案。
 *
 * 不用 chrome.i18n 的原因：布局/视觉回归把页面当普通 http 网页打开，
 * 那时没有扩展 API；而且手动切换界面语言也没法靠它做到。
 * 每行 = [key, 简体中文, English]，{0} {1} … 是占位符。
 * key 集合由 test/i18n.mjs 合并两个文件后双向校验。
 */
window.ZL_I18N = (function () {
  'use strict';
  var rows = [
    /* ---- 首屏 ---- */
    ['app.title', '新标签页', 'New tab'],
    ['app.noscript', '需要启用 JavaScript 才能显示此页面。', 'JavaScript is required to show this page.'],
    ['clock.aria', '时间', 'Clock'],
    ['clock.title', '点击进入极简模式', 'Click to toggle zen mode'],
    ['search.aria', '搜索', 'Search'],
    ['search.engineTitle', '切换搜索引擎', 'Switch search engine'],
    ['search.placeholder', '输入网址，或搜索', 'Enter a URL or search'],
    ['board.aria', '快捷方式与小组件', 'Shortcuts and widgets'],
    ['panel.settings', '设置', 'Settings'],
    ['panel.close', '关闭', 'Close'],

    /* ---- 设置分区 ---- */

    /* ---- 壁纸 ---- */

    /* ---- 主题 ---- */

    /* ---- 显示 / 语言 ---- */

    /* ---- 站点 ---- */

    /* ---- 图标 ---- */
    ['icon.enableSite', '启用网站图标', 'Enable site icons'],
    ['icon.reading', '正在读取…', 'Reading…'],
    ['icon.siteCandidate', '站点', 'Site'],
    ['icon.siteIconsFailed', '没能拿到图标（{0}）', 'Could not get icons ({0})'],

    /* ---- 同步 ---- */

    /* ---- 数据 / 快照 ---- */

    /* ---- 诊断 / 存储 ---- */

    /* ---- 看板 ---- */
    ['board.add', '＋ 添加组件', '+ Add widget'],
    ['board.resize', '调整尺寸', 'Resize'],
    ['board.removeWidget', '移除组件', 'Remove widget'],
    ['board.error', '组件出错：{0}', 'Widget error: {0}'],
    ['board.customIcon', '自定义图标…', 'Custom icon…'],
    ['board.changeIcon', '更换图标…', 'Change icon…'],
    ['board.defaultIcon', '恢复默认图标', 'Reset icon'],
    ['board.hideName', '隐藏名称', 'Hide name'],
    ['board.showName', '显示名称', 'Show name'],
    ['board.hide', '隐藏', 'Hide'],
    ['board.remove', '移除', 'Remove'],
    ['board.removeConfirm', '移除「{0}」？（不会影响书签）', 'Remove "{0}"? (bookmarks are untouched)'],
    ['board.iconUpdated', '图标已更新', 'Icon updated'],
    ['board.iconTooBig', '文件超过 2MB，先压一压再上传', 'File exceeds 2 MB, compress it first'],
    ['board.iconReadFail', '读不出文件内容', 'Could not read the file'],
    ['board.iconBadType', '不是可识别的图片（支持 PNG/JPEG/WebP/GIF/SVG/ICO/BMP）', 'Unrecognized image (PNG/JPEG/WebP/GIF/SVG/ICO/BMP only)'],
    ['board.iconDecodeFail', '这张图片解不出来，换一张试试', 'Could not decode this image'],
    ['board.keyboardHint', '方向键移动，Shift+方向键改尺寸，Delete 隐藏', 'Arrow keys move, Shift+arrows resize, Delete hides'],
    ['board.moved', '已移动到 {0}, {1}', 'Moved to {0}, {1}'],

    /* ---- 组件名 ---- */
    ['widget.todo', '待办', 'Todo'],
    ['widget.countdown', '纪念日', 'Countdown'],
    ['widget.calendar', '月历', 'Calendar'],
    ['widget.pomodoro', '番茄钟', 'Pomodoro'],
    ['widget.notes', '便签', 'Notes'],
    ['widget.calculator', '计算器', 'Calculator'],
    ['widget.money', '大写金额', 'Amount in words'],
    ['widget.unit', '单位换算', 'Unit converter'],

    /* ---- 组件内容 ---- */
    ['w.todo.placeholder', '添加待办，回车确认', 'Add a todo, press Enter'],
    ['w.todo.empty', '还没有待办', 'Nothing yet'],
    ['w.todo.delete', '删除', 'Delete'],
    ['w.count.defaultLabel', '我的生日', 'My birthday'],
    ['w.count.setDate', '点击设置日期', 'Click to set a date'],
    ['w.count.badDate', '日期格式不对', 'Invalid date format'],
    ['w.count.today', '就是今天 · ', 'Today · '],
    ['w.count.past', '已经 {0} 天 · ', '{0} days ago · '],
    ['w.count.future', '还有 {0} 天 · ', '{0} days left · '],
    ['w.count.promptLabel', '名称', 'Name'],
    ['w.count.promptDate', '日期（YYYY-MM-DD）', 'Date (YYYY-MM-DD)'],
    ['w.pomo.start', '开始', 'Start'],
    ['w.pomo.pause', '暂停', 'Pause'],
    ['w.pomo.next', '下一步', 'Next'],
    ['w.pomo.reset', '重置', 'Reset'],
    ['w.pomo.duration', '时长', 'Duration'],
    ['w.pomo.durationTitle', '设置工作/休息时长', 'Set focus / break length'],
    ['w.pomo.focus', '专注', 'Focus'],
    ['w.pomo.break', '休息', 'Break'],
    ['w.pomo.focusLabel', '工作', 'Focus'],
    ['w.pomo.breakLabel', '休息', 'Break'],
    ['w.pomo.focusAria', '工作时长（分钟）', 'Focus length (minutes)'],
    ['w.pomo.breakAria', '休息时长（分钟）', 'Break length (minutes)'],
    ['w.pomo.apply', '应用', 'Apply'],
    ['w.clock.date', '{0}月{1}日 星期{2}', '{0}/{1} {2}'],
    ['w.clock.week', '日 一 二 三 四 五 六', 'Sun Mon Tue Wed Thu Fri Sat'],
  ];

  var map = Object.create(null);
  function add(list) {
    for (var i = 0; i < list.length; i++) map[list[i][0]] = list[i];
  }
  add(rows);
  rows = rows.slice();

  var lang = 'zh_CN';

  function t(key) {
    var r = map[key];
    if (!r) return key;
    var s = r[lang === 'en' ? 2 : 1];
    for (var i = 1; i < arguments.length; i++) {
      s = s.split('{' + (i - 1) + '}').join(String(arguments[i]));
    }
    return s;
  }

  /* 按需补充字典；重复 key 以先加入的为准 */
  function extend(list) {
    for (var i = 0; i < list.length; i++) {
      if (!map[list[i][0]]) {
        map[list[i][0]] = list[i];
        rows.push(list[i]);
      }
    }
  }

  function apply() {
    if (typeof document === 'undefined') return;
    var root = document;
    var attrs = [
      ['data-i18n', 'textContent'],
      ['data-i18n-ph', 'placeholder'],
      ['data-i18n-title', 'title'],
      ['data-i18n-aria', 'aria-label']
    ];
    for (var a = 0; a < attrs.length; a++) {
      var nodes = root.querySelectorAll('[' + attrs[a][0] + ']');
      for (var n = 0; n < nodes.length; n++) {
        var key = nodes[n].getAttribute(attrs[a][0]);
        if (attrs[a][0] === 'data-i18n-title') nodes[n].title = t(key);
        else if (attrs[a][0] === 'data-i18n-aria') nodes[n].setAttribute('aria-label', t(key));
        else nodes[n][attrs[a][1]] = t(key);
      }
    }
    var title = root.querySelector('title[data-i18n]');
    if (title) root.title = t(title.getAttribute('data-i18n'));
  }

  function init(pref) {
    if (pref === 'en' || pref === 'zh_CN') lang = pref;
    else {
      var nav = (typeof navigator !== 'undefined' && navigator.language) || '';
      lang = /^zh/i.test(nav) ? 'zh_CN' : 'en';
    }
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.setAttribute('data-lang', lang === 'en' ? 'en' : 'zh_CN');
      document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
      var titleNode = document.querySelector('title[data-i18n]');
      if (titleNode) document.title = t(titleNode.getAttribute('data-i18n'));
    }
    return lang;
  }

  return {
    t: t, apply: apply, init: init, extend: extend,
    lang: function () { return lang; }, rows: rows
  };
})();
