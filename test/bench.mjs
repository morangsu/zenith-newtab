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
 *   interact  = 页面内 gear.click() → #panel 可交互（含按需 import 与面板渲染）
 *   体积      = 逐文件 gzip；首屏 / 按需按「每个版本自己的静态 import 图」划分，
 *              不能用当前版本的 LAZY_FILES 清单去套旧版本
 *
 * 每一轮都新建独立标签页，第 1 轮记为冷启动（单样本、波动大），
 * 其余为热启动，取中位数与 p90。真·冷启动多样本见 test/cold-start.mjs，
 * 其结果由 --report 自动读取。浏览器由脚本自己启动与回收。
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
const IS_META = (rel) => rel.startsWith('_locales/') || rel === 'BUILD.txt';
/* 首屏静态链路按「每个版本自己的静态 import 图」计算。
   不能直接拿当前 build.mjs 的 LAZY_FILES 清单去套 0.12.0：旧版 settings.js 是静态
   import，会被误归成按需，得出「旧版首屏更小」的反向结论。动态 import() 不匹配
   下面的行首正则，所以 0.13.x 的按需模块会自动落到 lazy。 */
function dependencyGraph(dir) {
  const seen = new Set();
  const resolve = (from, spec) => {
    /* HTML 里写的是 src="js/main.js"（不带 ./），ESM 里写的是 './foo.js'；
       两种都是相对路径，只有协议 URL 和根绝对路径才跳过。 */
    if (!spec || spec.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(spec)) return null;
    let p = join(dirname(from), spec).split('\\').join('/');
    if (!/\.(js|css|html|json)$/.test(p)) p += '.js';
    return existsSync(join(dir, p)) ? p : null;
  };
  const scan = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = readFileSync(join(dir, rel), 'utf8');
    for (const re of [
      /^\s*import\s+[^'"\n]*?\s+from\s*['"]([^'"]+)['"]/gm,
      /^\s*import\s+['"]([^'"]+)['"]/gm
    ]) {
      let m;
      while ((m = re.exec(src))) {
        const p = resolve(rel, m[1]);
        if (p) scan(p);
      }
    }
    if (rel.endsWith('.html')) {
      const tagRe = /<(?:script|link)[^>]*?(?:src|href)="([^"]+)"/g;
      let m;
      while ((m = tagRe.exec(src))) {
        const p = resolve(rel, m[1]);
        if (p) scan(p);
      }
    }
  };
  scan('newtab.html');

  /* 动态 import() 的目标才是按需模块。不能用「没被静态引用」来推断，否则
     js/version.js 这类既非静态也非动态的文件会被误算成 lazy，与 build.mjs
     的清单口径差 0.2 KB。所有 JS 文件都扫一遍，含按需模块自己的嵌套 import。 */
  const dynamic = new Set();
  const walkJs = (d) => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) { walkJs(abs); continue; }
      if (!name.endsWith('.js')) continue;
      const rel = relative(dir, abs).split('\\').join('/');
      const src = readFileSync(abs, 'utf8');
      const re = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      let m;
      while ((m = re.exec(src))) {
        const p = resolve(rel, m[1]);
        if (p) dynamic.add(p);
      }
    }
  };
  walkJs(dir);
  return { static: seen, dynamic };
}
/* build.mjs 的清单只作为期望值用于诊断漂移，不参与分类。 */
const lazyMatch = /const LAZY_FILES = new Set\(\[([\s\S]*?)\]\)/.exec(
  readFileSync(join(ROOT, 'build.mjs'), 'utf8')
);
const LAZY_FILES = new Set(
  lazyMatch ? [...lazyMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []
);

mkdirSync(BENCH, { recursive: true });

/* ---------- 对比报告 ---------- */

if (has('report')) {
  const files = argv.slice(argv.indexOf('--report') + 1).filter((s) => !s.startsWith('--'));
  if (files.length < 2) {
    console.error('用法：node test/bench.mjs --report before.json after.json');
    process.exit(1);
  }
  const [a, b] = files.map((f) => JSON.parse(readFileSync(join(BENCH, f), 'utf8')));
  /* 冷启动多轮数据由 test/cold-start.mjs 单独采集（每轮全新浏览器进程 + profile）。
     文件存在就用它的中位数，否则回退到基准里的单样本冷启动。 */
  const coldOf = (label) => {
    const p = join(BENCH, label + '-cold.json');
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  };
  const coldA = coldOf(a.label);
  const coldB = coldOf(b.label);
  const coldVal = (c, fallback) => (c && c.median != null ? c.median : fallback);
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

  add('首屏静态链路 gzip（BUDGET_FIRST 口径）', a.static.firstGzip / 1024, b.static.firstGzip / 1024, ' KB');
  add('按需模块 gzip（不进首屏解析）', a.static.lazyGzip / 1024, b.static.lazyGzip / 1024, ' KB');
  add('页面 gzip 总量', a.static.pageGzip / 1024, b.static.pageGzip / 1024, ' KB');
  add('后台 gzip 总量', a.static.bgGzip / 1024, b.static.bgGzip / 1024, ' KB');
  add('首帧三文件原始字节（boot.js+CSS+HTML，未压缩）', a.static.criticalBytes, b.static.criticalBytes, ' B');
  add('JS 模块数', a.static.jsFiles, b.static.jsFiles, '');
  add('文件总数', a.static.fileCount, b.static.fileCount, '');
  add('热启动 rendered（中位数）', a.runtime.warm.rendered, b.runtime.warm.rendered, ' ms');
  add('热启动 rendered（p90）', a.runtime.warm.renderedP90, b.runtime.warm.renderedP90, ' ms');
  add(`冷启动 rendered（${coldA && coldB ? coldA.samples.length + '/' + coldB.samples.length + ' 次独立进程' : '单样本'}）`,
    coldVal(coldA, a.runtime.cold.rendered), coldVal(coldB, b.runtime.cold.rendered), ' ms');
  add('首次交互：点齿轮 → 设置面板可交互（中位数）',
    a.runtime.warm.interactMs, b.runtime.warm.interactMs, ' ms');
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
- 采样：每次新建独立标签页，热启动 ${Math.max(0, (b.runtime.sampleCount || 1) - 1)} 次，取中位数与 p90；冷启动由 \`test/cold-start.mjs\` 每轮用**全新浏览器进程 + profile** 单独采集${coldA && coldB ? ` ${coldA.samples.length} / ${coldB.samples.length} 次` : '（本次未做多轮，表中为单样本）'}
- 口径：\`rendered\` 为 boot.js 起到首个 requestAnimationFrame（页面自记 \`zl.perf\`）；「首次交互」从页面内 \`gear.click()\` 起到 \`#panel\` 显示且出现 \`.panel-card\`（含按需 import 与面板渲染）；其余来自 NavigationTiming / PaintTiming / CDP Performance.getMetrics

| 指标 | ${a.label} | ${b.label} | 变化 |
|---|---:|---:|---:|
${rows.join('\n')}

> 读表注意：
> - **两个「首屏」不是一回事，不能换算**：\`首屏静态链路 gzip\` 是 build.mjs BUDGET_FIRST 的口径
>   （首屏必须解析的所有文件逐文件 gzip 累加）；\`首帧三文件原始字节\` 只是 boot.js + newtab.css +
>   newtab.html 三个阻塞文件的**未压缩**字节，不含任何 JS 模块。README 里的「xx / 70 KB」指前者。
> - 「页面 gzip 总量」把**按需模块**（点开设置 / 快照 / 轮播才下载解析）也算进去了，
>   不等于新标签页首屏实际要解析的量。
> - 「首次交互」是 0.13.0 把设置面板改成按需加载后**被转移的成本**：首屏 DOM 节点变少
>   不等于总工作量变少，必须与 rendered、DOM 节点数一起看。
> - 时间类指标受宿主机负载影响，必须用同一脚本、同一浏览器、相近时间连续采样做相对比较；
>   跨天/跨负载的绝对值不可直接比。冷启动即便多轮采样，波动仍大于热启动。
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
const GRAPH = dependencyGraph(EXT_DIR);
let rawTotal = 0, pageGzip = 0, bgGzip = 0, iconGzip = 0;
let firstGzip = 0, lazyGzip = 0, metaGzip = 0;
let criticalBytes = 0, jsFiles = 0;
const byFile = [];
for (const rel of files) {
  const buf = readFileSync(join(EXT_DIR, rel));
  const gz = gzipSync(buf).length;
  rawTotal += buf.length;
  if (IS_ICON(rel)) iconGzip += gz;
  else if (BG_FILES.has(rel)) bgGzip += gz;
  else {
    pageGzip += gz;
    /* 按需 = 从 HTML 入口沿静态 import 图不可达的 JS 模块（settings.js 静态
       import 的 pack/config/storage 也算，因为它们整条链都不在首屏）。
       js/version.js 是构建生成的版本元数据，虽然不可达仍计入首屏，
       与 build.mjs 的 LAZY_FILES 清单口径保持一致。 */
    if (IS_META(rel)) metaGzip += gz;
    else if (rel.endsWith('.js') && !GRAPH.static.has(rel) && rel !== 'js/version.js') lazyGzip += gz;
    else firstGzip += gz;
  }
  /* 另一个独立口径：首帧阻塞链路三个文件的「原始字节」，未压缩、不含 JS 模块。
     它和 firstGzip 不是一回事，报告里必须分开列。 */
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
  firstGzip,
  lazyGzip,
  metaGzip,
  criticalBytes,
  jsFiles,
  largest: byFile.sort((x, y) => y.gzip - x.gzip).slice(0, 8)
};

console.log(`\n[静态·${LABEL}] ${files.length} 文件　首屏静态链路 gzip ${(firstGzip / 1024).toFixed(1)} KB　` +
  `按需 ${(lazyGzip / 1024).toFixed(1)} KB　页面合计 ${(pageGzip / 1024).toFixed(1)} KB　` +
  `后台 ${(bgGzip / 1024).toFixed(1)} KB　首帧三文件原始 ${criticalBytes} B`);
/* 只对 0.13.x 及以上做清单一致性诊断：旧版本本来就没有按需模块。 */
if (files.includes('js/strings-extra.js')) {
  const calc = new Set(files.filter((rel) =>
    rel.endsWith('.js') && !GRAPH.static.has(rel) && rel !== 'js/version.js' &&
    !BG_FILES.has(rel)
  ));
  const diff = [...LAZY_FILES].filter((x) => !calc.has(x))
    .concat([...calc].filter((x) => !LAZY_FILES.has(x)));
  if (diff.length) console.log(`  ! 依赖图与 build.mjs 的 LAZY_FILES 不一致：${diff.join(', ')}`);
}
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

/* 首次交互延迟：0.13.0 起设置面板改成点齿轮才动态 import，成本被移到这一刻。
   判据用两个版本都有的 DOM（#panel 显示 + .panel-card 出现），
   所以 0.12.0 的「本来就在首屏」也会如实测出一个接近 0 的值。 */
const INTERACT_EXPR = `(async () => {
  const gear = document.getElementById('gear');
  const panel = document.getElementById('panel');
  if (!gear || !panel) return { ok: false, reason: 'no-gear-or-panel' };
  const start = performance.now();
  gear.click();
  while (performance.now() - start < 10000) {
    if (!panel.hidden && panel.querySelector('.panel-card')) {
      return { ok: true, ms: performance.now() - start,
        nodes: document.querySelectorAll('*').length };
    }
    await new Promise((r) => setTimeout(r, 8));
  }
  return { ok: false, ms: null, reason: 'timeout' };
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

  /* 扩展 service worker 空闲后会休眠、target 消失，所以启动后立刻抓 ID。
     Edge 会同时跑内置 service_worker，URL 也可能以 background.js 结尾；
     必须按 manifest 的 newtab 覆盖认出 Zenith，否则会导航到内置组件而 404。 */
  const isZenithSw = async (sw) => {
    let session = null;
    try {
      session = await connect(sw.webSocketDebuggerUrl);
      const r = await session.send('Runtime.evaluate', {
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
    finally { if (session) session.ws.close(); }
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

      /* 交互测量必须放在 getMetrics 之后，否则面板渲染会被算进 ScriptDuration，
         污染原有指标。每个标签页都是独立 realm，每轮测到的都是「首次」import。 */
      let interact = null;
      try {
        const ir = await send('Runtime.evaluate', {
          expression: INTERACT_EXPR, returnByValue: true, awaitPromise: true
        });
        interact = ir && ir.result && ir.result.value;
      } catch { /* 面板打不开记 null，不中断整个基准 */ }

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
        taskMs: round2((m.TaskDuration || 0) * 1000),
        interactMs: interact && interact.ok ? round2(interact.ms) : null,
        interactNodes: interact && interact.ok ? interact.nodes : null
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
      taskMs: pick('taskMs').median,
      interactMs: pick('interactMs').median
    },
    samples
  };
  console.log(`[运行时·${LABEL}] 冷启动 ${runtime.cold.rendered} ms　` +
    `热启动中位数 ${runtime.warm.rendered} ms / p90 ${runtime.warm.renderedP90} ms　` +
    `FCP ${runtime.warm.fcp} ms　DOM ${runtime.warm.domNodes} 节点　Script ${runtime.warm.scriptMs} ms　` +
    `首次交互 ${runtime.warm.interactMs == null ? '—' : runtime.warm.interactMs + ' ms'}`);

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
