/* 可复现性能基准：静态体积 + 真实浏览器新标签页启动耗时。
 *
 *   node test/bench.mjs --label before            # 测当前 dist/chrome，写 bench/before.json
 *   node test/bench.mjs --label after --ext dist/chrome
 *   node test/bench.mjs --report before.json after.json
 *
 * 测量口径（改造前后完全一致，不需要在被测页面里插桩）：
 *   rendered  = boot.js 开始 → 首个 requestAnimationFrame（页面自己记在 zl.perf）
 *   fcp / fp  = PerformancePaintTiming
 *   dcl / load= NavigationTiming
 *   domNodes  = document.querySelectorAll('*').length
 *   script/layout/style/task = CDP Performance.getMetrics（每轮独立 target）
 *   体积      = 逐文件 gzip，按 build.mjs 的口径分页面 / 后台 / 图标
 *
 * 每一轮都新建独立标签页，第 1 轮记为冷启动（含扩展首次唤醒），
 * 其余为热启动，取中位数与 p90。浏览器由脚本自己启动与回收。
 */
import { spawn } from 'node:child_process';
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, cpSync,
  existsSync, readdirSync, statSync
} from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BENCH = join(ROOT, 'bench');
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes('--' + name);

const DEFAULT_BROWSER = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const LABEL = arg('label', 'current');
const EXT_DIR = arg('ext', join(ROOT, 'dist', 'chrome'));
const BROWSER = arg('browser', DEFAULT_BROWSER);
const ROUNDS = Math.max(3, Number(arg('rounds', '12')));
const PORT = Number(arg('port', String(9400 + Math.floor(Math.random() * 200))));
const BASE = `http://127.0.0.1:${PORT}`;
const BG_FILES = new Set(['background.js', 'sync-core.js']);
const IS_ICON = (rel) => rel.startsWith('icons/') || rel === 'icon.svg';

mkdirSync(BENCH, { recursive: true });

/* ---------- 对比报告 ---------- */

if (has('report')) {
  const files = argv.slice(argv.indexOf('--report') + 1).filter((s) => !s.startsWith('--'));
  if (files.length < 2) {
    console.error('用法：node test/bench.mjs --report before.json after.json');
    process.exit(1);
  }
  const [a, b] = files.map((f) => JSON.parse(readFileSync(join(BENCH, f), 'utf8')));
  const pct = (x, y) => {
    if (x === 0 || x == null || y == null) return '—';
    const d = (y / x - 1) * 100;
    return (d >= 0 ? '+' : '') + d.toFixed(1) + '%';
  };
  const fmt = (v, unit = '') =>
    v == null ? '—' : (typeof v === 'number' ? v.toFixed(v < 10 ? 2 : 1) : String(v)) + unit;
  const rows = [];
  const add = (name, x, y, unit = '') => {
    rows.push(`| ${name} | ${fmt(x, unit)} | ${fmt(y, unit)} | ${pct(x, y)} |`);
  };

  add('页面 gzip 总量', a.static.pageGzip / 1024, b.static.pageGzip / 1024, ' KB');
  add('后台 gzip 总量', a.static.bgGzip / 1024, b.static.bgGzip / 1024, ' KB');
  add('首屏链路字节（boot+CSS+HTML）', a.static.criticalBytes, b.static.criticalBytes, ' B');
  add('JS 模块数', a.static.jsFiles, b.static.jsFiles, '');
  add('文件总数', a.static.fileCount, b.static.fileCount, '');
  add('热启动 rendered（中位数）', a.runtime.warm.rendered, b.runtime.warm.rendered, ' ms');
  add('热启动 rendered（p90）', a.runtime.warm.renderedP90, b.runtime.warm.renderedP90, ' ms');
  add('冷启动 rendered', a.runtime.cold.rendered, b.runtime.cold.rendered, ' ms');
  add('FCP（中位数）', a.runtime.warm.fcp, b.runtime.warm.fcp, ' ms');
  add('DCL（中位数）', a.runtime.warm.dcl, b.runtime.warm.dcl, ' ms');
  add('DOM 节点数', a.runtime.warm.domNodes, b.runtime.warm.domNodes, '');
  add('ScriptDuration（中位数）', a.runtime.warm.scriptMs, b.runtime.warm.scriptMs, ' ms');
  add('LayoutDuration（中位数）', a.runtime.warm.layoutMs, b.runtime.warm.layoutMs, ' ms');
  add('RecalcStyleDuration（中位数）', a.runtime.warm.styleMs, b.runtime.warm.styleMs, ' ms');
  add('TaskDuration（中位数）', a.runtime.warm.taskMs, b.runtime.warm.taskMs, ' ms');

  const md = `# Zenith 性能对比：${a.label} → ${b.label}

- 测量时间：${a.at} / ${b.at}
- 浏览器：${b.browser}
- 采样：每次新建独立标签页，冷启动 1 次 + 热启动 ${Math.max(0, (b.runtime.sampleCount || 1) - 1)} 次，取中位数与 p90
- 口径：\`rendered\` 为 boot.js 起到首个 requestAnimationFrame（页面自记 \`zl.perf\`）；其余来自 NavigationTiming / PaintTiming / CDP Performance.getMetrics

| 指标 | ${a.label} | ${b.label} | 变化 |
|---|---:|---:|---:|
${rows.join('\n')}

> 读表注意：
> - 「页面 gzip 总量」把**按需模块**（点开设置 / 快照 / 轮播才下载解析）也算进去了，
>   不等于新标签页首屏实际要解析的量；首屏链路另由 build.mjs 的 BUDGET_FIRST 单独约束。
> - 冷启动只有 1 个样本，波动远大于热启动，结论以热启动中位数为准。
> - 时间类指标受宿主机负载影响，必须用同一脚本、同一浏览器、相近时间连续采样做相对比较；
>   跨天/跨负载的绝对值不可直接比。
`;
  writeFileSync(join(BENCH, 'COMPARE.md'), md);
  console.log(md);
  console.log('已写入 bench/COMPARE.md');
  process.exit(0);
}

/* ---------- 静态体积 ---------- */

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs, base));
    else out.push(relative(base, abs).split('\\').join('/'));
  }
  return out;
}

if (!existsSync(EXT_DIR)) {
  console.error('找不到扩展目录：' + EXT_DIR + '（先跑 node build.mjs）');
  process.exit(1);
}

const files = walk(EXT_DIR);
let rawTotal = 0, pageGzip = 0, bgGzip = 0, iconGzip = 0;
let criticalBytes = 0, jsFiles = 0;
const byFile = [];
for (const rel of files) {
  const buf = readFileSync(join(EXT_DIR, rel));
  const gz = gzipSync(buf).length;
  rawTotal += buf.length;
  if (IS_ICON(rel)) iconGzip += gz;
  else if (BG_FILES.has(rel)) bgGzip += gz;
  else pageGzip += gz;
  if (rel === 'js/boot.js' || rel === 'newtab.css' || rel === 'newtab.html') criticalBytes += buf.length;
  if (rel.endsWith('.js')) jsFiles++;
  byFile.push({ rel, raw: buf.length, gzip: gz });
}
const stat = {
  fileCount: files.length,
  rawTotal,
  pageGzip,
  bgGzip,
  iconGzip,
  criticalBytes,
  jsFiles,
  largest: byFile.sort((x, y) => y.gzip - x.gzip).slice(0, 8)
};

console.log(`\n[静态·${LABEL}] ${files.length} 文件　原始 ${(rawTotal / 1024).toFixed(1)} KB　` +
  `页面 ${(pageGzip / 1024).toFixed(1)} KB　后台 ${(bgGzip / 1024).toFixed(1)} KB　` +
  `首屏链路 ${criticalBytes} B`);
for (const f of stat.largest) console.log(`  ${f.rel.padEnd(28)} ${String(f.gzip).padStart(7)} B gzip`);

if (has('static-only')) {
  writeFileSync(join(BENCH, LABEL + '.json'), JSON.stringify({
    label: LABEL, at: new Date().toISOString(), ext: EXT_DIR,
    browser: '(静态测量)', static: stat, runtime: null
  }, null, 2));
  process.exit(0);
}

/* ---------- 浏览器启动 ---------- */

/* 扩展目录带空格时 Edge 的内容校验偶发误判，统一复制到无空格临时路径，
   让 before / after 两组只差代码本身。 */
const extCopy = join(tmpdir(), 'zl-bench-ext-' + LABEL.replace(/[^\w-]/g, ''));
const profile = join(tmpdir(), 'zl-bench-profile-' + PORT);
rmSync(extCopy, { recursive: true, force: true });
rmSync(profile, { recursive: true, force: true });
cpSync(EXT_DIR, extCopy, { recursive: true });

const browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-extension-debugging',
  `--load-extension=${extCopy}`,
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  'about:blank'
], { stdio: 'ignore', windowsHide: true });

let browserExited = false;
browser.on('exit', () => { browserExited = true; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp(path, init) {
  const res = await fetch(BASE + path, init);
  return res.json();
}

async function waitFor(fn, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (browserExited) throw new Error('浏览器进程提前退出');
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error('等待超时');
}

/* WebSocket = CDP 会话；connect 到某个 target 并封装 send */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
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
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send };
}

const SAMPLE_EXPR = `(() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const paints = {};
  for (const p of performance.getEntriesByType('paint')) paints[p.name] = p.startTime;
  let perf = null;
  try { perf = JSON.parse(sessionStorage.getItem('zl.perf') || 'null'); } catch (e) {}
  return {
    rendered: perf ? perf.rendered : null,
    boot: perf ? perf.boot : null,
    fcp: paints['first-contentful-paint'] ?? null,
    fp: paints['first-paint'] ?? null,
    dcl: nav.domContentLoadedEventEnd ?? null,
    load: nav.loadEventEnd ?? null,
    domNodes: document.querySelectorAll('*').length,
    resourceCount: performance.getEntriesByType('resource').length,
    now: performance.now()
  };
})()`;

function median(arr) {
  const a = arr.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.floor(a.length / 2)];
}
function p90(arr) {
  const a = arr.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.ceil(a.length * 0.9) - 1)];
}
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

let result;
try {
  await waitFor(async () => {
    const v = await cdp('/json/version');
    return v && v.Browser ? v : null;
  });

  /* 扩展 service worker 空闲后会休眠、target 消失，所以启动后立刻抓 ID */
  const extId = await waitFor(async () => {
    const list = await cdp('/json/list');
    const sw = list.find((t) =>
      t.type === 'service_worker' && /background\.js$/.test(t.url || '')
    );
    if (!sw) return null;
    const m = /chrome-extension:\/\/([^/]+)/.exec(sw.url);
    return m ? m[1] : null;
  }, 25000);
  console.log(`[浏览器·${LABEL}] CDP ${PORT}　扩展 ID ${extId}`);

  const samples = [];
  for (let i = 0; i < ROUNDS; i++) {
    /* 先建空页、启用 Performance 域，再导航——否则 metrics 从加载后才开始
       累积，ScriptDuration 永远是 0。 */
    const page = await cdp('/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' });
    const { ws, send } = await connect(page.webSocketDebuggerUrl);
    try {
      await send('Page.enable');
      await send('Performance.enable');
      await send('Page.navigate', { url: `chrome-extension://${extId}/newtab.html` });

      /* 等页面自己把 zl.perf 写出来（首个 rAF 之后） */
      let sample = null;
      for (let k = 0; k < 40; k++) {
        const r = await send('Runtime.evaluate', { expression: SAMPLE_EXPR, returnByValue: true });
        const v = r && r.result && r.result.value;
        if (v && v.rendered != null) { sample = v; break; }
        await sleep(60);
      }
      if (!sample) throw new Error('页面没有写出 zl.perf（可能 404）');

      const metrics = await send('Performance.getMetrics');
      const m = Object.fromEntries((metrics.metrics || []).map((x) => [x.name, x.value]));
      samples.push({
        rendered: round2(sample.rendered),
        fcp: round2(sample.fcp),
        fp: round2(sample.fp),
        dcl: round2(sample.dcl),
        load: round2(sample.load),
        domNodes: sample.domNodes,
        resourceCount: sample.resourceCount,
        scriptMs: round2((m.ScriptDuration || 0) * 1000),
        layoutMs: round2((m.LayoutDuration || 0) * 1000),
        styleMs: round2((m.RecalcStyleDuration || 0) * 1000),
        taskMs: round2((m.TaskDuration || 0) * 1000)
      });
    } finally {
      ws.close();
      await cdp('/json/close/' + page.id).catch(() => {});
    }
    await sleep(120);
  }

  const warm = samples.slice(1);
  const pick = (key) => ({
    median: median(warm.map((s) => s[key])),
    p90: p90(warm.map((s) => s[key]))
  });
  const runtime = {
    sampleCount: samples.length,
    cold: samples[0],
    warm: {
      rendered: pick('rendered').median,
      renderedP90: pick('rendered').p90,
      fcp: pick('fcp').median,
      fp: pick('fp').median,
      dcl: pick('dcl').median,
      load: pick('load').median,
      domNodes: pick('domNodes').median,
      resourceCount: pick('resourceCount').median,
      scriptMs: pick('scriptMs').median,
      layoutMs: pick('layoutMs').median,
      styleMs: pick('styleMs').median,
      taskMs: pick('taskMs').median
    },
    samples
  };
  console.log(`[运行时·${LABEL}] 冷启动 ${runtime.cold.rendered} ms　` +
    `热启动中位数 ${runtime.warm.rendered} ms / p90 ${runtime.warm.renderedP90} ms　` +
    `FCP ${runtime.warm.fcp} ms　DOM ${runtime.warm.domNodes} 节点　Script ${runtime.warm.scriptMs} ms`);

  result = {
    label: LABEL,
    at: new Date().toISOString(),
    ext: EXT_DIR,
    browser: BROWSER,
    port: PORT,
    static: stat,
    runtime
  };
  writeFileSync(join(BENCH, LABEL + '.json'), JSON.stringify(result, null, 2));
  console.log('已写入 bench/' + LABEL + '.json');
} catch (e) {
  console.error('基准测量失败：' + (e && e.message));
  process.exitCode = 1;
} finally {
  try { browser.kill(); } catch { /* 已退出 */ }
  await sleep(400);
  rmSync(extCopy, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
}
