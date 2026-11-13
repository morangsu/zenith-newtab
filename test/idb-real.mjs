#!/usr/bin/env node
/**
 * idb-real.mjs — 在真实浏览器 + 真实 IndexedDB 上跑快照/回滚。
 *
 * 为什么需要它：test/features.mjs 用的是内存 IndexedDB 桩，只能验证逻辑，
 * 验证不了 DB v1→v2 升级、上限淘汰是否真的落盘、以及「换一个页面还能读回来」。
 * 这里把 dist/chrome 的模块挂在普通 HTTP origin 上（127.0.0.1 仍是 secure context，
 * crypto.subtle 可用），用两个独立页面验证持久化。不需要加载扩展。
 *
 * 用法：node test/idb-real.mjs（可加 EDGE_PATH 指定浏览器）
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, cpSync,
  readdirSync, statSync, existsSync
} from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXT = join(ROOT, 'dist', 'chrome');
const BROWSER = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const WORK = join(tmpdir(), 'zl-idb-real-' + process.pid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(EXT)) {
  console.error('找不到 dist/chrome，先跑 node build.mjs');
  process.exit(1);
}

const freePort = () => new Promise((resolve, reject) => {
  const s = createNetServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

/* ---------- 准备一个普通 HTTP origin ---------- */
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
cpSync(EXT, WORK, { recursive: true });
writeFileSync(join(WORK, 'probe.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>zl-idb-probe</title></head>
<body><script type="module">
  import * as S from './js/snapshots.js';
  import * as I from './js/idb.js';
  window.__zl = { S, I };
  window.__ready = true;
</script></body></html>`);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml'
};
const server = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'probe.html';
  const abs = join(WORK, rel);
  if (!abs.startsWith(WORK) || !statSync(abs, { throwIfNoEntry: false })) {
    res.writeHead(404); res.end('not found'); return;
  }
  const ext = rel.slice(rel.lastIndexOf('.'));
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(readFileSync(abs));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const PROFILE = join(tmpdir(), 'zl-idb-real-profile-' + process.pid);
rmSync(PROFILE, { recursive: true, force: true });
const browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=${PROFILE}`, 'about:blank'
], { stdio: 'ignore', windowsHide: true });
const CDP = `http://127.0.0.1:${PORT + 1}`;

/* ---------- CDP ---------- */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  return { ready, send, close: () => ws.close() };
}
const cdp = async (path, init) => (await fetch(CDP + path, init)).json();

async function newPage() {
  const p = await cdp('/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' });
  const s = connect(p.webSocketDebuggerUrl);
  await s.ready;
  await s.send('Page.enable');
  await s.send('Page.navigate', { url: BASE + '/probe.html' });
  for (let k = 0; k < 60; k++) {
    const r = await s.send('Runtime.evaluate', {
      expression: '!!(window.__zl && window.__ready)', returnByValue: true
    });
    if (r && r.result && r.result.value) return { page: p, session: s };
    await sleep(100);
  }
  throw new Error('probe 页面模块没加载成功');
}

/* 页面 A：v1→v2 升级、快照去重、上限淘汰、恢复与自动备份 */
const TEST_A = `(async () => {
  const { S, I } = window.__zl;
  const out = [];
  const ok = (name, cond, extra) => out.push({ name, pass: !!cond, extra: extra == null ? '' : String(extra) });

  /* 1) 先造一个 v1 数据库，再让 idb.js 以 v2 打开，模拟老用户升级 */
  const legacy = await new Promise((resolve, reject) => {
    const req = indexedDB.open('zl', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('icons')) db.createObjectStore('icons');
    };
    req.onsuccess = () => {
      const db = req.result;
      const t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').put('legacy-value', 'legacy-key');
      t.oncomplete = () => { db.close(); resolve(); };
      t.onerror = () => reject(t.error);
    };
    req.onerror = () => reject(req.error);
  }).then(() => true).catch((e) => e.message);
  ok('v1 老库写入成功', legacy === true, legacy);

  const got = await I.idbGet('kv', 'legacy-key');
  ok('v1→v2 升级保留旧 kv 数据', got === 'legacy-value', got);
  const v2 = await new Promise((resolve, reject) => {
    const req = indexedDB.open('zl', 2);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  ok('v2 建出 snaps store', v2.objectStoreNames.contains('snaps'));
  ok('v2 保留 kv / icons', v2.objectStoreNames.contains('kv') && v2.objectStoreNames.contains('icons'));
  v2.close();

  /* 2) 快照：去重、上限、淘汰顺序 */
  await S.clearSnapshots();
  const mk = (n) => ({
    v: 1, ui: { scale: 1 + n / 100, lang: 'auto' }, theme: { mode: 'auto' },
    wallpaper: { type: 'preset', preset: 'aurora', slides: [] }, engine: 'bing',
    items: [{ id: 'a', url: 'https://a.com' }], widgetData: {}, widgetConfig: {}, syncByType: {}
  });
  const r1 = await S.takeSnapshot(mk(1), 'test');
  ok('首份快照真的写入', r1.created === true);
  const r2 = await S.takeSnapshot(mk(1), 'test');
  ok('同状态不重复存', r2.created === false);
  ok('列表只有一份', (await S.listSnapshots()).length === 1);
  for (let i = 2; i <= S.SNAP_LIMIT + 5; i++) await S.takeSnapshot(mk(i), 'test');
  const rows = await S.listSnapshots();
  ok('不超过 SNAP_LIMIT', rows.length === S.SNAP_LIMIT, rows.length + '/' + S.SNAP_LIMIT);
  ok('最新排在最前', rows[0].ts > rows[1].ts);
  ok('最旧的已被淘汰', (await S.readSnapshot(r1.ts)) === null);
  ok('快照保留 items', (await S.readSnapshot(rows[0].ts)).state.items.length === 1);

  /* 3) 恢复会自动备份当前状态，即使已经到上限 */
  const target = rows[rows.length - 1];
  const restored = await S.restoreSnapshot(target.ts, mk(999));
  ok('恢复返回目标状态（不是当前的 mk(999)）', !!restored && restored.ui.scale < 10, restored && restored.ui.scale);
  const after = await S.listSnapshots();
  ok('恢复后出现 manual 备份', after.some((r) => r.reason === 'manual'));
  ok('恢复后仍不超上限', after.length === S.SNAP_LIMIT, after.length);

  /* 4) 其它 store 的操作不会误伤快照 */
  await I.idbPut('icons', 'a.com', { fake: true });
  await I.idbClear('icons');
  ok('清空 icons 不影响 snaps', (await S.listSnapshots()).length === S.SNAP_LIMIT);

  /* 5) 给页面 B 留一个持久化凭据 */
  localStorage.setItem('zl.idbprobe', JSON.stringify({
    count: after.length, hasManual: after.some((r) => r.reason === 'manual'),
    legacy: got, scale: restored.ui.scale
  }));
  return { out, saved: JSON.parse(localStorage.getItem('zl.idbprobe')) };
})()`;

/* 页面 B：全新 realm / 全新 idb.js 单例，验证数据真的落盘 */
const TEST_B = `(async () => {
  const { S } = window.__zl;
  const rows = await S.listSnapshots();
  const saved = JSON.parse(localStorage.getItem('zl.idbprobe') || 'null');
  const out = [];
  const ok = (name, cond, extra) => out.push({ name, pass: !!cond, extra: extra == null ? '' : String(extra) });
  ok('页面 B 读回同样数量的快照', saved && rows.length === saved.count, rows.length);
  ok('页面 B 仍能读到 manual 备份', saved && saved.hasManual && rows.some((r) => r.reason === 'manual'));
  ok('页面 B 的 localStorage 与页面 A 一致', saved && saved.legacy === 'legacy-value');
  ok('页面 B 可以直接 readSnapshot', !!(await S.readSnapshot(rows[0].ts)));
  return { out, rows: rows.length };
})()`;

let pass = 0;
const failures = [];
let pageA = null, pageB = null;
try {
  for (let k = 0; k < 60; k++) {
    try { const v = await cdp('/json/version'); if (v && v.Browser) break; } catch {}
    await sleep(150);
  }
  pageA = await newPage();
  const a = await pageA.session.send('Runtime.evaluate', {
    expression: TEST_A, returnByValue: true, awaitPromise: true
  });
  if (a.exceptionDetails) throw new Error('页面 A 抛异常：' + (a.exceptionDetails.text || ''));
  const ar = a.result.value;

  pageB = await newPage();
  const b = await pageB.session.send('Runtime.evaluate', {
    expression: TEST_B, returnByValue: true, awaitPromise: true
  });
  if (b.exceptionDetails) throw new Error('页面 B 抛异常：' + (b.exceptionDetails.text || ''));
  const br = b.result.value;

  for (const row of [...ar.out, ...br.out]) {
    if (row.pass) pass++;
    else failures.push(row.name + (row.extra ? '  → ' + row.extra : ''));
  }
  console.log(`真实 IndexedDB：v1→v2 升级、${ar.saved.count} 份快照、跨页面读回`);
} catch (e) {
  failures.push('执行异常：' + (e && e.message));
} finally {
  if (pageA) { pageA.session.close(); await cdp('/json/close/' + pageA.page.id).catch(() => {}); }
  if (pageB) { pageB.session.close(); await cdp('/json/close/' + pageB.page.id).catch(() => {}); }
  browser.kill();
  server.close();
  await sleep(200);
  rmSync(WORK, { recursive: true, force: true });
  rmSync(PROFILE, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} 项`);
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f);
  console.log(`失败 ${failures.length} 项`);
  process.exit(1);
}
console.log('✓ 全部通过');
