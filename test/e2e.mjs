/* 端到端检查：连到已加载扩展的 service worker 与新标签页，验证
   1) 后台能启动（说明 importScripts 路径正确）
   2) sync-core 在后台可用
   3) 新标签页在真实 CSP 下正常渲染
   4) 页面 → 后台的消路通

   用法（需要先起一个带扩展的无头浏览器）：
     msedge --headless=new --load-extension=<dist/chrome> --remote-debugging-port=9333 about:blank
     node test/e2e.mjs [port]
*/
const PORT = Number(process.argv[2] || 9333);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) pass++;
  else failures.push(name + (extra ? '  → ' + extra : ''));
};

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const events = [];

  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });

  return { ready, send, events, close: () => ws.close() };
}

const list = await (await fetch(`${BASE}/json/list`)).json();
const swTarget = list.find((t) => t.type === 'service_worker' && /background\.js$/.test(t.url || ''));
ok('扩展后台已启动', !!swTarget, list.map((t) => t.type + ':' + t.url).join(' | '));
if (!swTarget) {
  console.log(`\n通过 ${pass} 项`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}

const extId = swTarget.url.split('/')[2];

/* ---------- 后台 ---------- */
const bg = connect(swTarget.webSocketDebuggerUrl);
await bg.ready;
await bg.send('Runtime.enable');

const coreInfo = await bg.send('Runtime.evaluate', {
  expression: `({
    hasCore: typeof ZLSync !== 'undefined',
    canon: (typeof ZLSync !== 'undefined') ? ZLSync.canonical({b:1,a:2}) : null,
    version: chrome.runtime.getManifest().version,
    hasImport: typeof importScripts === 'function',
    actionListener: !!(chrome.action && chrome.action.onClicked && chrome.action.onClicked.hasListeners())
  })`,
  returnByValue: true
});
const info = coreInfo.result.value;
ok('sync-core 已在后台载入', info.hasCore === true);
ok('canonical 结果正确', info.canon === '{"a":2,"b":1}', String(info.canon));
ok('后台是经典 worker', info.hasImport === true);
ok('manifest 版本可读', /^\d+\.\d+\.\d+$/.test(info.version || ''), info.version);
ok('工具栏按钮已注册点击处理', info.actionListener === true, String(info.actionListener));

/* ---------- 新标签页 ---------- */
const created = await (
  await fetch(`${BASE}/json/new?${encodeURIComponent(`chrome-extension://${extId}/newtab.html`)}`, {
    method: 'PUT'
  })
).json();
ok('新标签页已打开', !!created.webSocketDebuggerUrl);

const page = connect(created.webSocketDebuggerUrl);
await page.ready;
await page.send('Runtime.enable');
await page.send('Log.enable');
await new Promise((r) => setTimeout(r, 800));

const pageInfo = await page.send('Runtime.evaluate', {
  expression: `({
    tiles: document.querySelectorAll('.tile').length,
    cards: document.querySelectorAll('.card').length,
    clock: document.getElementById('clock-time').textContent,
    lunar: document.getElementById('clock-lunar').textContent,
    nav: performance.getEntriesByType('navigation').length
  })`,
  returnByValue: true
});
const p = pageInfo.result.value;
ok('图标渲染出来了', p.tiles > 0, String(p.tiles));
ok('组件渲染出来了', p.cards > 0, String(p.cards));
ok('时钟在走', /^\d{2}:\d{2}:\d{2}$/.test(p.clock), p.clock);
ok('农历有值', !!p.lunar && p.lunar.length > 1, p.lunar);

/* 设置面板：异步加载同步配置后应当完整渲染 */
await page.send('Runtime.evaluate', {
  expression: `document.getElementById('gear').click()`,
  userGesture: true
});
await new Promise((r) => setTimeout(r, 400));
const panelInfo = await page.send('Runtime.evaluate', {
  expression: `({
    secs: document.querySelectorAll('.panel h3').length,
    hasSync: !!document.getElementById('sync-status'),
    hasExport: !!document.getElementById('export-btn'),
    provider: (() => {
      const labels = [...document.querySelectorAll('.panel .btn')].map(b => b.textContent);
      return ['关闭', 'WebDAV', 'GitHub'].filter(x => labels.includes(x));
    })()
  })`,
  returnByValue: true
});
const pi = panelInfo.result.value;
ok('设置面板分区完整', pi.secs >= 9, String(pi.secs));
ok('同步状态行已渲染', pi.hasSync === true);
ok('导出按钮已渲染', pi.hasExport === true);
ok('同步方式三个按钮在位', pi.provider.length === 3, pi.provider.join(','));

/* 上架相关：图标文件真的能加载、工具栏按钮真的存在 */
const iconInfo = await page.send('Runtime.evaluate', {
  expression: `(async () => {
    const mf = chrome.runtime.getManifest();
    const load = (name) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth);
      img.onerror = () => resolve(0);
      img.src = chrome.runtime.getURL(name);
    });
    return {
      declared: Object.keys(mf.icons || {}),
      action: !!(mf.action && mf.action.default_title),
      size16: await load('icons/icon16.png'),
      size128: await load('icons/icon128.png')
    };
  })()`,
  awaitPromise: true,
  returnByValue: true
});
const ii = iconInfo.result.value;
ok('manifest 声明了图标', ii.declared.length >= 3, ii.declared.join(','));
ok('工具栏按钮已声明', ii.action === true);
ok('16px 图标可加载且尺寸正确', ii.size16 === 16, String(ii.size16));
ok('128px 图标可加载且尺寸正确', ii.size128 === 128, String(ii.size128));

/* 页面 → 后台 的消息通路 */
const msgResult = await page.send('Runtime.evaluate', {
  expression: `new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'zl:sync', action: 'pull', settings: { provider: 'off' } }, (res) => {
      resolve({ res, err: chrome.runtime.lastError ? chrome.runtime.lastError.message : null });
    });
  })`,
  awaitPromise: true,
  returnByValue: true
});
const m = msgResult.result.value;
ok('消息通路正常（后台有响应）', !!m && !!m.res, JSON.stringify(m));
ok(
  '未配置同步时后台明确拒绝',
  m && m.res && m.res.ok === false && /未配置/.test(m.res.error || ''),
  JSON.stringify(m && m.res)
);

/* 主机权限默认未授予 */
const perm = await page.send('Runtime.evaluate', {
  expression: `chrome.permissions.contains({ origins: ['https://api.github.com/*'] })`,
  awaitPromise: true,
  returnByValue: true
});
ok('主机权限默认未授予', perm.result.value === false, String(perm.result.value));

/* 页面控制台不应该有异常 */
const errors = page.events.filter(
  (e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
);
ok('页面无 JS 异常', errors.length === 0, errors.map((e) => JSON.stringify(e.params).slice(0, 160)).join(' | '));

/* 后台也检查一遍 */
const bgErrors = bg.events.filter((e) => e.method === 'Runtime.exceptionThrown');
ok('后台无 JS 异常', bgErrors.length === 0, bgErrors.map((e) => JSON.stringify(e.params).slice(0, 160)).join(' | '));

bg.close();
page.close();
await fetch(`${BASE}/json/close/${created.id}`).catch(() => {});

console.log(`\n通过 ${pass} 项`);
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ 端到端检查全部通过');
process.exit(0);
