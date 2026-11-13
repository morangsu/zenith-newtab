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

/* CDP evaluate 统一兜底：全新 profile 首次加载时表达式可能抛异常或还没就绪，
   直接读 result.value 会把整个测试打成 TypeError，看不到真实原因。 */
async function evaluate(session, expression, extra = {}) {
  try {
    const r = await session.send('Runtime.evaluate', {
      expression, returnByValue: true, ...extra
    });
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails;
      return { value: null, error: (d.exception && d.exception.description) || d.text || 'exception' };
    }
    return { value: r && r.result ? r.result.value : null, error: null };
  } catch (e) {
    return { value: null, error: (e && e.message) || 'send failed' };
  }
}

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
/* Edge 会同时跑几个内置 service_worker，URL 也可能以 background.js 结尾。
   必须用 manifest 特征认出 Zenith，否则会把内置组件当成被测扩展
   （曾表现为 getManifest().version = '1.2'、chrome.runtime 在页面里 undefined）。 */
const swCandidates = list.filter((t) =>
  t.type === 'service_worker' && /background\.js$/.test(t.url || '')
);
let swTarget = null;
let extId = null;
for (const t of swCandidates) {
  const probeSession = connect(t.webSocketDebuggerUrl);
  try {
    await probeSession.ready;
    const probe = await evaluate(probeSession, `(() => {
      try {
        const m = chrome.runtime.getManifest();
        return { version: m.version, newtab: m.chrome_url_overrides && m.chrome_url_overrides.newtab };
      } catch (e) { return null; }
    })()`);
    const v = probe.value;
    if (v && v.newtab === 'newtab.html' && /^\d+\.\d+\.\d+$/.test(v.version || '')) {
      swTarget = t;
      extId = t.url.split('/')[2];
      break;
    }
  } catch { /* target 刚消失，换下一个 */ }
  finally { probeSession.close(); }
}
ok('扩展后台已启动（按 manifest 认出 Zenith）', !!swTarget,
  swCandidates.map((t) => t.type + ':' + t.url).join(' | '));
if (!swTarget) {
  console.log(`\n通过 ${pass} 项`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}

/* ---------- 后台 ---------- */
const bg = connect(swTarget.webSocketDebuggerUrl);
await bg.ready;
await bg.send('Runtime.enable');

const coreProbe = await evaluate(bg, `({
    hasCore: typeof ZLSync !== 'undefined',
    canon: (typeof ZLSync !== 'undefined') ? ZLSync.canonical({b:1,a:2}) : null,
    version: chrome.runtime.getManifest().version,
    hasImport: typeof importScripts === 'function',
    actionListener: !!(chrome.action && chrome.action.onClicked && chrome.action.onClicked.hasListeners())
  })`);
const info = coreProbe.value || {};
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

/* 全新 profile 首次打开扩展页可能比 800ms 慢；轮询等 DOM 就绪，
   否则 evaluate 直接读 null.textContent 会抛异常，结果里没有 value。 */
let p = null;
for (let k = 0; k < 40 && !p; k++) {
  const pageInfo = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const clock = document.getElementById('clock-time');
      if (!clock) return null;
      return {
        tiles: document.querySelectorAll('.tile').length,
        cards: document.querySelectorAll('.card').length,
        clock: clock.textContent,
        lunar: (document.getElementById('clock-lunar') || {}).textContent || '',
        nav: performance.getEntriesByType('navigation').length
      };
    })()`,
    returnByValue: true
  });
  if (pageInfo && pageInfo.result) p = pageInfo.result.value;
  if (!p) await new Promise((r) => setTimeout(r, 100));
}
ok('新标签页 DOM 就绪', !!p);
if (!p) p = { tiles: 0, cards: 0, clock: '', lunar: '' };
ok('图标渲染出来了', p.tiles > 0, String(p.tiles));
ok('组件渲染出来了', p.cards > 0, String(p.cards));
ok('时钟在走', /^\d{2}:\d{2}:\d{2}$/.test(p.clock), p.clock);
ok('农历有值', !!p.lunar && p.lunar.length > 1, p.lunar);

/* 设置面板：异步加载同步配置后应当完整渲染 */
await page.send('Runtime.evaluate', {
  expression: `document.getElementById('gear').click()`,
  userGesture: true
});
/* 0.13.0 起设置面板是按需 import，等它真正挂载完再验，顺便覆盖首次交互路径 */
let pi = null;
for (let k = 0; k < 40 && !pi; k++) {
  const probe = await evaluate(page, `(() => {
    if (!document.querySelector('#panel .panel-card')) return null;
    const labels = [...document.querySelectorAll('.panel .btn')].map(b => b.textContent);
    return {
      secs: document.querySelectorAll('.panel h3').length,
      hasSync: !!document.getElementById('sync-status'),
      hasExport: !!document.getElementById('export-btn'),
      provider: ['关闭', 'WebDAV', 'GitHub'].filter(x => labels.includes(x))
    };
  })()`);
  if (probe.value) pi = probe.value;
  if (!pi) await new Promise((r) => setTimeout(r, 100));
}
if (!pi) pi = { secs: 0, hasSync: false, hasExport: false, provider: [] };
ok('设置面板分区完整', pi.secs >= 9, String(pi.secs));
ok('同步状态行已渲染', pi.hasSync === true);
ok('导出按钮已渲染', pi.hasExport === true);
ok('同步方式三个按钮在位', pi.provider.length === 3, pi.provider.join(','));

/* 上架相关：图标文件真的能加载、工具栏按钮真的存在 */
const iconProbe = await evaluate(page, `(async () => {
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
  })()`, { awaitPromise: true });
const ii = iconProbe.value || { declared: [], action: false, size16: 0, size128: 0 };
ok('manifest 声明了图标', ii.declared.length >= 3, iconProbe.error || ii.declared.join(','));
ok('工具栏按钮已声明', ii.action === true);
ok('16px 图标可加载且尺寸正确', ii.size16 === 16, String(ii.size16));
ok('128px 图标可加载且尺寸正确', ii.size128 === 128, String(ii.size128));

/* 页面 → 后台 的消息通路 */
const msgProbe = await evaluate(page, `new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'zl:sync', action: 'pull', settings: { provider: 'off' } }, (res) => {
      resolve({ res, err: chrome.runtime.lastError ? chrome.runtime.lastError.message : null });
    });
  })`, { awaitPromise: true });
const m = msgProbe.value;
ok('消息通路正常（后台有响应）', !!m && !!m.res, JSON.stringify(m));
ok(
  '未配置同步时后台明确拒绝',
  m && m.res && m.res.ok === false && /未配置/.test(m.res.error || ''),
  JSON.stringify(m && m.res)
);

/* 主机权限默认未授予 */
const perm = await evaluate(page,
  `chrome.permissions.contains({ origins: ['https://api.github.com/*'] })`,
  { awaitPromise: true });
ok('主机权限默认未授予', perm.value === false, perm.error || String(perm.value));

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
