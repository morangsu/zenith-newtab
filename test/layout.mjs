/* 自由布局回归测试：拖到指定格是否停住、被压住的项是否顺延、窄屏是否越界、
   新增组件是否落在末尾。需要本机有 Chrome/Edge。

   用法：node test/layout.mjs（可加 EDGE_PATH 指定浏览器） */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, copyFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

const CDP = 9410;
const HTTP = 8860;
const BROWSER = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = 'E:/WorkBuddy AI/richang/local/zenith';
const WORK = join(ROOT, '.layouttest');

function walk(dir, base = dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const abs = join(dir, n);
    if (statSync(abs).isDirectory()) out.push(...walk(abs, base));
    else out.push(relative(base, abs).split('\\').join('/'));
  }
  return out;
}
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
for (const rel of walk(join(ROOT, 'dist', 'chrome'))) {
  const to = join(WORK, rel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(ROOT, 'dist', 'chrome', rel), to);
}

writeFileSync(join(WORK, 'probe.js'), `import './js/main.js';\nawait new Promise((r) => setTimeout(r, 600));\n`);

const html = join(WORK, 'newtab.html');
writeFileSync(html, readFileSync(html, 'utf8').replace('src="js/main.js"', 'src="probe.js"'));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'newtab.html';
  const abs = join(WORK, rel);
  if (!abs.startsWith(WORK) || !statSync(abs, { throwIfNoEntry: false })) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[abs.slice(abs.lastIndexOf('.'))] || 'application/octet-stream' });
  res.end(readFileSync(abs));
});
await new Promise((r) => server.listen(HTTP, '127.0.0.1', r));

const profile = join(tmpdir(), 'zenith-layout');
rmSync(profile, { recursive: true, force: true });
const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP}`,
  '--window-size=1280,800', 'about:blank'
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const assert = [];
const ok = (name, cond, extra = '') => assert.push({ name, cond, extra });

async function main() {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break;
    } catch {}
    await sleep(250);
  }

  const page = await (await fetch(
    `http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${HTTP}/newtab.html`)}`,
    { method: 'PUT' }
  )).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m.result);
      pend.delete(m.id);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pend.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  const ev = (expression, opt = {}) =>
    send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...opt }).then(
      (r) => (r.exceptionDetails ? { ERROR: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception || {}).description } : r.result.value)
    );

  await sleep(1200);

  const geom = await ev(`(() => {
    const b = document.getElementById('board');
    const r = b.getBoundingClientRect();
    const cellW = (r.width - 12 * 7) / 8;
    const rowH = 104;
    const at = (c, rw) => ({ x: r.left + (c - 1) * (cellW + 12) + cellW / 2, y: r.top + (rw - 1) * (rowH + 12) + rowH / 2 });
    return { cellW, rowH, p13: at(1, 3), p33: at(3, 3), p73: at(7, 3) };
  })()`);

  const before = await ev(`[...document.querySelectorAll('#board > *:not(.drop-hint)')].map((n) => ({
    id: n.dataset.id || n.className,
    col: n.style.gridColumn,
    row: n.style.gridRow
  }))`);

  /* 把第一个图标拖到第 3 行第 7 列 */
  const drag = await ev(`(async () => {
    const board = document.getElementById('board');
    const tile = board.querySelector('.tile');
    const start = tile.getBoundingClientRect();
    const dt = new DataTransfer();
    const fire = (node, type, x, y) => node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    fire(tile, 'dragstart', start.left + start.width / 2, start.top + start.height / 2);
    await new Promise((r) => setTimeout(r, 60));
    fire(board, 'dragover', ${geom.p73.x}, ${geom.p73.y});
    await new Promise((r) => setTimeout(r, 60));
    fire(board, 'drop', ${geom.p73.x}, ${geom.p73.y});
    await new Promise((r) => setTimeout(r, 250));
    const moved = board.querySelector('.tile');
    return { col: moved.style.gridColumn, row: moved.style.gridRow };
  })()`);

  ok('拖到第 7 列第 3 行后停在那里', drag && drag.col === '7 / span 1' && drag.row === '3 / span 1', JSON.stringify(drag));

  const after = await ev(`[...document.querySelectorAll('#board > *:not(.drop-hint)')].map((n) => n.style.gridColumn + '|' + n.style.gridRow)`);
  const dup = after.filter((v, i) => after.indexOf(v) !== i);
  ok('没有两项占同一格', dup.length === 0, JSON.stringify(dup));

  /* 再打开一次：坐标应该持久化，位置不变 */
  await ev(`location.reload()`);
  await sleep(1500);
  const reloaded = await ev(`[...document.querySelectorAll('#board > *:not(.drop-hint)')].map((n) => n.style.gridColumn + '|' + n.style.gridRow)`);
  ok('刷新后位置保持不变', JSON.stringify(reloaded) === JSON.stringify(after), JSON.stringify(reloaded));

  /* 拖到已占用的格子：原来那项要顺延 */
  const push = await ev(`(async () => {
    const board = document.getElementById('board');
    const tiles = [...board.querySelectorAll('.tile')];
    const first = tiles[0];
    const second = tiles[1];
    const target = second.getBoundingClientRect();
    const start = first.getBoundingClientRect();
    const dt = new DataTransfer();
    const fire = (node, type, x, y) => node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    const beforeSecond = second.style.gridColumn + '|' + second.style.gridRow;
    fire(first, 'dragstart', start.left + start.width / 2, start.top + start.height / 2);
    await new Promise((r) => setTimeout(r, 60));
    fire(board, 'dragover', target.left + target.width / 2, target.top + target.height / 2);
    await new Promise((r) => setTimeout(r, 60));
    fire(board, 'drop', target.left + target.width / 2, target.top + target.height / 2);
    await new Promise((r) => setTimeout(r, 300));
    const tiles2 = [...board.querySelectorAll('.tile')];
    const b = [...board.querySelectorAll('#board > *:not(.drop-hint)')];
    const coords = b.map((n) => n.style.gridColumn + '|' + n.style.gridRow);
    return {
      beforeSecond,
      first: tiles2[0].style.gridColumn + '|' + tiles2[0].style.gridRow,
      second: tiles2[1].style.gridColumn + '|' + tiles2[1].style.gridRow,
      dup: coords.filter((v, i) => coords.indexOf(v) !== i)
    };
  })()`);
  ok('被压住的项挪开了（没有重叠）', push && push.dup.length === 0, JSON.stringify(push));
  ok('抢占者落在目标位置', push && push.first === push.beforeSecond, JSON.stringify(push));

  /* 窄屏：坐标要换算到 4 列，超出的顺延 */
  await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 820, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  const narrow = await ev(`[...document.querySelectorAll('#board > *:not(.drop-hint)')].map((n) => ({
    col: n.style.gridColumn, row: n.style.gridRow
  }))`);
  const badCol = narrow.filter((n) => {
    const m = n.col.match(/^(\d+) \/ span (\d+)$/);
    return m && Number(m[1]) + Number(m[2]) - 1 > 4;
  });
  ok('窄屏没有越出 4 列', badCol.length === 0, JSON.stringify(badCol));
  const nshot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(WORK, 'layout-narrow.png'), Buffer.from(nshot.data, 'base64'));

  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(600);

  /* 新增组件要落在现有内容的下面 */
  const added = await ev(`(async () => {
    const rows = () => [...document.querySelectorAll('#board > *:not(.drop-hint)')]
      .map((n) => parseInt(n.style.gridRow, 10) || 0);
    const maxBefore = Math.max(...rows());
    document.getElementById('widget-add').click();
    await new Promise((r) => setTimeout(r, 200));
    const item = [...document.querySelectorAll('.picker-item')].find((b) => b.textContent === '便签');
    if (item) item.click();
    await new Promise((r) => setTimeout(r, 400));
    const maxAfter = Math.max(...rows());
    return { maxBefore, maxAfter, count: document.querySelectorAll('#board > *:not(.drop-hint)').length };
  })()`);
  ok('新增组件落在最后一行之后', added && added.maxAfter > added.maxBefore, JSON.stringify(added));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(WORK, 'layout.png'), Buffer.from(shot.data, 'base64'));

  console.log('\n初始布局');
  for (const b of before) console.log('  ' + b.id + '  ' + b.col + ' | ' + b.row);

  let fail = 0;
  console.log('');
  for (const a of assert) {
    console.log((a.cond ? '✓ ' : '✗ ') + a.name + (a.cond ? '' : '  → ' + a.extra));
    if (!a.cond) fail++;
  }
  console.log(`\n通过 ${assert.length - fail} / ${assert.length}`);
  console.log('截图: ' + join(WORK, 'layout.png'));
  child.kill();
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  child.kill();
  process.exit(1);
});
