#!/usr/bin/env node
/**
 * cold-start.mjs — 真·冷启动多样本基准。
 *
 * bench.mjs 里的「冷启动」只是同一浏览器进程的第一个标签页，样本只有 1 个，
 * 波动远大于热启动。这里每轮都用**全新浏览器进程 + 全新 user-data-dir**，
 * 覆盖扩展首次加载、service worker 冷建、profile 无缓存的真实路径。
 *
 * 用法：
 *   node test/cold-start.mjs --label before3 --ext bench/baseline-dist/chrome --rounds 9
 *   node test/cold-start.mjs --label after3  --ext dist/chrome --rounds 9
 *
 * 输出 bench/<label>-cold.json，供 `test/bench.mjs --report` 自动读取。
 */
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BENCH = join(ROOT, 'bench');
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const LABEL = arg('label', 'current');
const EXT_DIR = arg('ext', join(ROOT, 'dist', 'chrome'));
const BROWSER = arg('browser', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
const ROUNDS = Math.max(3, Number(arg('rounds', '9')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(EXT_DIR)) {
  console.error('找不到扩展目录：' + EXT_DIR);
  process.exit(1);
}
mkdirSync(BENCH, { recursive: true });

const freePort = () => new Promise((resolve, reject) => {
  const s = createNetServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});

const median = (arr) => {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : null;
};
const p90 = (arr) => {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.ceil(a.length * 0.9) - 1)] : null;
};
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

/* 扩展目录带空格时 Edge 内容校验偶发误判，统一复制到无空格临时路径。 */
const extCopy = join(tmpdir(), 'zl-cold-ext-' + LABEL.replace(/[^\w-]/g, ''));
rmSync(extCopy, { recursive: true, force: true });
cpSync(EXT_DIR, extCopy, { recursive: true });

const SAMPLE_EXPR = `(() => {
  let perf = null;
  try { perf = JSON.parse(sessionStorage.getItem('zl.perf') || 'null'); } catch (e) {}
  const nav = performance.getEntriesByType('navigation')[0] || {};
  return { rendered: perf ? perf.rendered : null,
           dcl: nav.domContentLoadedEventEnd ?? null,
           nodes: document.querySelectorAll('*').length };
})()`;

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

async function oneRound(index) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const profile = join(tmpdir(), `zl-cold-profile-${LABEL.replace(/[^\w-]/g, '')}-${index}-${port}`);
  rmSync(profile, { recursive: true, force: true });

  const browser = spawn(BROWSER, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-extension-debugging',
    `--load-extension=${extCopy}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  const cdp = async (path, init) => (await fetch(base + path, init)).json();
  const waitFor = async (fn, ms = 20000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try { const v = await fn(); if (v) return v; } catch { /* 还没起来 */ }
      await sleep(150);
    }
    throw new Error('等待超时');
  };

  let session = null, page = null;
  try {
    await waitFor(async () => {
      const v = await cdp('/json/version');
      return v && v.Browser ? v : null;
    });
    /* 内置 service_worker 也可能叫 background.js，按 manifest 认出 Zenith */
    const isZenithSw = async (sw) => {
      let s = null;
      try {
        s = connect(sw.webSocketDebuggerUrl);
        await s.ready;
        const r = await s.send('Runtime.evaluate', {
          expression: `(() => {
            try {
              const m = chrome.runtime.getManifest();
              return (m.chrome_url_overrides && m.chrome_url_overrides.newtab) || '';
            } catch (e) { return ''; }
          })()`,
          returnByValue: true
        });
        return !!(r && r.result && r.result.value === 'newtab.html');
      } catch { return false; }
      finally { if (s) s.close(); }
    };
    const extId = await waitFor(async () => {
      const list = await cdp('/json/list');
      for (const sw of list.filter((t) =>
        t.type === 'service_worker' && /background\.js$/.test(t.url || '')
      )) {
        if (await isZenithSw(sw)) {
          const m = /chrome-extension:\/\/([^/]+)/.exec(sw.url);
          if (m) return m[1];
        }
      }
      return null;
    }, 25000);

    page = await cdp('/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' });
    session = connect(page.webSocketDebuggerUrl);
    await session.ready;
    await session.send('Page.enable');
    await session.send('Page.navigate', { url: `chrome-extension://${extId}/newtab.html` });

    let sample = null;
    for (let k = 0; k < 50; k++) {
      const r = await session.send('Runtime.evaluate', {
        expression: SAMPLE_EXPR, returnByValue: true
      });
      const v = r && r.result && r.result.value;
      if (v && v.rendered != null) { sample = v; break; }
      await sleep(60);
    }
    if (!sample) throw new Error('页面没有写出 zl.perf');
    return { rendered: round2(sample.rendered), dcl: round2(sample.dcl), nodes: sample.nodes };
  } finally {
    if (session) session.close();
    if (page) await cdp('/json/close/' + page.id).catch(() => {});
    browser.kill();
    await sleep(250);
    rmSync(profile, { recursive: true, force: true });
  }
}

const samples = [];
const errors = [];
for (let i = 0; i < ROUNDS; i++) {
  try {
    const r = await oneRound(i);
    samples.push(r);
    process.stdout.write(`  ${i + 1}/${ROUNDS} rendered ${r.rendered} ms\r`);
  } catch (e) {
    errors.push(`第 ${i + 1} 轮：${e && e.message}`);
    process.stdout.write(`  ${i + 1}/${ROUNDS} 失败\r`);
  }
}
console.log('');

const rendered = samples.map((s) => s.rendered);
const out = {
  label: LABEL,
  at: new Date().toISOString(),
  ext: EXT_DIR,
  browser: BROWSER,
  rounds: ROUNDS,
  samples: rendered,
  median: round2(median(rendered)),
  p90: round2(p90(rendered)),
  min: rendered.length ? Math.min(...rendered) : null,
  max: rendered.length ? Math.max(...rendered) : null,
  dclMedian: round2(median(samples.map((s) => s.dcl))),
  domNodes: round2(median(samples.map((s) => s.nodes))),
  errors
};
writeFileSync(join(BENCH, LABEL + '-cold.json'), JSON.stringify(out, null, 2));
rmSync(extCopy, { recursive: true, force: true });
console.log(`[冷启动·${LABEL}] ${rendered.length}/${ROUNDS} 次成功　` +
  `中位数 ${out.median} ms　p90 ${out.p90} ms　范围 ${out.min}–${out.max} ms`);
console.log('已写入 bench/' + LABEL + '-cold.json');
if (errors.length) {
  for (const e of errors) console.error('  ! ' + e);
  process.exit(1);
}
