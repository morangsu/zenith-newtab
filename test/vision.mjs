/* 壁纸可读性回归测试：在真实浏览器里渲染、采样、算 WCAG 对比度。
   需要本机有 Chrome 或 Edge，所以不放进 npm test（CI 通常没浏览器）。

   用法：node test/vision.mjs
   可选：EDGE_PATH 指定浏览器路径

   测的是"图片壁纸 + 浅色/深色主题"下最坏位置的文字对比度。
   用的是构造出来的极端壁纸（右上刺白、左下压黑），比真实照片更严格。
*/
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const WORK = join(ROOT, '.vision');
const PORT = 8849;

let pass = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) pass++;
  else failures.push(`${name}${extra ? '  → ' + extra : ''}`);
};

const BROWSERS = [
  process.env.EDGE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) {
  console.error('找不到 Chrome/Edge（可用 EDGE_PATH 指定）');
  process.exit(1);
}

/* ---------- 准备测试页 ---------- */

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs, base));
    else out.push(relative(base, abs).split('\\').join('/'));
  }
  return out;
}

const DIST = join(ROOT, 'dist', 'chrome');
if (!existsSync(DIST)) {
  console.error('缺少 dist/chrome，先跑 node build.mjs');
  process.exit(1);
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
for (const rel of walk(DIST)) {
  const to = join(WORK, rel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(DIST, rel), to);
}

/* 用状态而不是 CSS 变量来设定场景：产品里 state 是真相，直接改 --veil-a 会被主干覆盖 */
writeFileSync(
  join(WORK, 'probe.js'),
  `const q = new URLSearchParams(location.search);
const image = q.get('img') === '1';
const enhance = q.get('enh') === '1';
const theme = q.get('theme') || '';
const veil = Number(q.get('veil') || 0);

const { defaultState } = await import('./js/store.js');
const s = defaultState();
s.wallpaper.type = image ? 'image' : 'preset';
if (image) s.wallpaper.imageDim = veil; else s.wallpaper.dim = veil;
/* 遮罩强度按「手动主题 / 跟随系统」取不同的值，所以状态里的主题模式必须一起设，
   只改 data-theme 属性是不够的 */
s.theme = { mode: theme || 'auto' };
localStorage.setItem('zl.state', JSON.stringify(s));
if (theme) document.documentElement.setAttribute('data-theme', theme);

await import('./js/main.js');

/* 对照组：关掉图片壁纸保底，还原修复前的表现 */
if (image && !enhance) {
  document.documentElement.removeAttribute('data-wall');
  document.documentElement.style.setProperty('--veil-a', '0');
}

if (image) {
  const bg = document.getElementById('bg');
  bg.style.backgroundImage = [
    'radial-gradient(circle at 74% 22%, #ffffff 0%, #fbfdff 9%, rgba(251,253,255,0) 26%)',
    'radial-gradient(ellipse 60% 46% at 26% 82%, #101216 0%, #1b1e25 34%, rgba(27,30,37,0) 62%)',
    'linear-gradient(176deg, #d6ecff 0%, #a8d2f4 42%, #6b9ecb 68%, #33475e 100%)'
  ].join(', ');
}

const sample = () => {
  const cs = getComputedStyle(document.documentElement);
  const parse = (c) => {
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (m) {
      const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    const h = c.replace('#', '');
    const n = h.length === 3 ? h.split('').map((x) => x + x) : h.match(/../g);
    return { r: parseInt(n[0], 16), g: parseInt(n[1], 16), b: parseInt(n[2], 16), a: 1 };
  };
  const over = (t, b) => ({
    r: t.r * t.a + b.r * (1 - t.a),
    g: t.g * t.a + b.g * (1 - t.a),
    b: t.b * t.a + b.b * (1 - t.a),
    a: 1
  });
  const lum = (c) => {
    const f = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const la = lum(a);
    const lb = lum(b);
    return Number(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)).toFixed(2));
  };
  const vr = cs.getPropertyValue('--veil-rgb').trim().split(/\\s+/).map(Number);
  const va = Number(cs.getPropertyValue('--veil-a')) || 0;
  const veilC = { r: vr[0], g: vr[1], b: vr[2], a: va };
  const fg = parse(cs.getPropertyValue('--fg').trim());
  const card = parse(cs.getPropertyValue('--card').trim());
  const bright = over(veilC, { r: 252, g: 253, b: 255, a: 1 });
  const dark = over(veilC, { r: 20, g: 23, b: 28, a: 1 });
  const sky = over(veilC, { r: 150, g: 190, b: 225, a: 1 });
  return {
    clockOverBright: ratio(fg, bright),
    nameOverDark: ratio(fg, dark),
    nameOverSky: ratio(fg, sky),
    cardOnBright: ratio(fg, over(card, bright)),
    theme: document.documentElement.getAttribute('data-theme') || 'auto',
    veil: va,
    wall: document.documentElement.getAttribute('data-wall') || 'none'
  };
};

await new Promise((r) => setTimeout(r, 700));
document.title = 'M ' + JSON.stringify(sample());
`
);
const htmlPath = join(WORK, 'newtab.html');
writeFileSync(htmlPath, readFileSync(htmlPath, 'utf8').replace('src="js/main.js"', 'src="probe.js"'));

/* ---------- 起静态服务（页面是 module，走 http 更稳） ---------- */

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'newtab.html';
  const abs = join(WORK, rel);
  if (!abs.startsWith(WORK) || !existsSync(abs)) {
    res.writeHead(404);
    res.end('nope');
    return;
  }
  const ext = abs.slice(abs.lastIndexOf('.'));
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(readFileSync(abs));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

/* ---------- 逐场景跑浏览器 ---------- */

const profile = join(tmpdir(), 'zenith-vision-' + process.pid);
/* 必须用异步 exec：同步版本会冻结事件循环，同进程里的静态服务器就没法
   响应浏览器的请求，浏览器一直等到超时——这是死锁，不是慢。 */
const measure = (query, tag) =>
  new Promise((resolve) => {
    execFile(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        `--user-data-dir=${join(profile, tag)}`,
        '--window-size=1280,800',
        '--virtual-time-budget=6000',
        '--dump-dom',
        `http://127.0.0.1:${PORT}/newtab.html${query}`
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60000 },
      (err, stdout) => {
        if (err && !stdout) {
          resolve(null);
          return;
        }
        const m = String(stdout).match(/<title>M (\{.*?\})<\/title>/);
        resolve(m ? JSON.parse(m[1]) : null);
      }
    );
  });

const scenes = {
  dark: await measure('?img=1&enh=1&theme=dark&veil=0.5', 'dark'),
  light: await measure('?img=1&enh=1&theme=light&veil=0.5', 'light'),
  preset: await measure('?img=0&theme=dark&veil=0', 'preset'),
  before: await measure('?img=1&enh=0&theme=dark&veil=0', 'before')
};

server.close();
rmSync(profile, { recursive: true, force: true });
rmSync(WORK, { recursive: true, force: true });

/* ---------- 断言 ---------- */

for (const [k, v] of Object.entries(scenes)) {
  if (!v) {
    console.error(`✗ 场景 ${k} 没有取到测量结果（浏览器可能没起来）`);
    process.exit(1);
  }
}

ok('深色主题：时钟压在亮处 ≥ 3.0（大字号 AA）', scenes.dark.clockOverBright >= 3.0, String(scenes.dark.clockOverBright));
ok('深色主题：图标名压天空 ≥ 4.5', scenes.dark.nameOverSky >= 4.5, String(scenes.dark.nameOverSky));
ok('深色主题：卡片内文字 ≥ 4.5', scenes.dark.cardOnBright >= 4.5, String(scenes.dark.cardOnBright));
ok('浅色主题：图标名压暗部 ≥ 4.5', scenes.light.nameOverDark >= 4.5, String(scenes.light.nameOverDark));
ok('浅色主题：卡片内文字 ≥ 4.5', scenes.light.cardOnBright >= 4.5, String(scenes.light.cardOnBright));
ok('预设壁纸不受遮罩影响', scenes.preset.veil === 0 && scenes.preset.wall === 'preset', JSON.stringify(scenes.preset));
ok(
  '对照：修复前确实不达标（说明测试有区分力）',
  scenes.before.clockOverBright < 2 && scenes.before.cardOnBright < 2,
  JSON.stringify(scenes.before)
);

console.log('\n场景测量');
console.log('─'.repeat(72));
for (const [k, v] of Object.entries(scenes)) {
  console.log(
    `  ${k.padEnd(8)} 时钟/亮 ${String(v.clockOverBright).padStart(5)}　名/暗 ${String(v.nameOverDark).padStart(5)}　名/天 ${String(v.nameOverSky).padStart(5)}　卡片 ${String(v.cardOnBright).padStart(5)}　veil ${v.veil}`
  );
}
console.log('─'.repeat(72));
console.log(`\n通过 ${pass} 项`);
if (failures.length) {
  console.log('失败：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('✓ 壁纸可读性检查全部通过');
