// 生成 Edge / Chrome 商店需要的图片：
//   docs/store/logo-300.png        300x300 商店标志
//   docs/store/promo-440x280.png   小型促销瓷砖
//   docs/store/promo-1400x560.png  大型促销瓷砖
// 复用 render-icons.mjs 的浏览器矢量渲染方案，只在本机运行。
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'store');

const CANDIDATES = [
  process.env.EDGE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
].filter(Boolean);
const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error('找不到 Chrome/Edge，可用 EDGE_PATH 环境变量指定');
  process.exit(1);
}

const rawSvg = readFileSync(join(ROOT, 'src', 'icon.svg'), 'utf8');
const iconAt = (size) => rawSvg.replace(/<svg([^>]*)>/, `<svg$1 width="${size}" height="${size}">`);

const page = (w, h, body, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${w}px;height:${h}px;overflow:hidden}
body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;background:#111319;color:#fff}
${extra}
</style></head><body>${body}</body></html>`;

const promoBody = (w, h, icon, titleSize, subSize, pad) => `
<div style="position:absolute;inset:0;background:linear-gradient(135deg,#2a3040 0%,#1a1e28 55%,#111319 100%)"></div>
<div style="position:absolute;right:${-h * 0.22}px;bottom:${-h * 0.42}px;width:${h * 1.1}px;height:${h * 1.1}px;border-radius:50%;background:radial-gradient(circle,#2b6ba655 0%,#2b6ba622 55%,transparent 72%)"></div>
<div style="position:absolute;left:${pad}px;top:50%;transform:translateY(-50%);display:flex;align-items:center;gap:${Math.round(icon * 0.42)}px">
  ${iconAt(icon)}
  <div>
    <div style="font-size:${titleSize}px;font-weight:700;letter-spacing:2px;color:#f4f7fb">Zenith 起始页</div>
    <div style="margin-top:${Math.round(titleSize * 0.38)}px;font-size:${subSize}px;color:#9fb4c9;letter-spacing:1px">安静的本地新标签页 · 不联网 · 零数据收集</div>
  </div>
</div>`;

const ASSETS = [
  { name: 'logo-300.png', w: 300, h: 300, body: `<div style="display:flex;align-items:center;justify-content:center;width:300px;height:300px">${iconAt(300)}</div>` },
  { name: 'promo-440x280.png', w: 440, h: 280, body: promoBody(440, 280, 96, 44, 20, 36) },
  { name: 'promo-1400x560.png', w: 1400, h: 560, body: promoBody(1400, 560, 200, 92, 38, 96) }
];

const work = join(tmpdir(), 'zenith-store-img');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(OUT, { recursive: true });

for (const a of ASSETS) {
  const out = join(OUT, a.name);
  const pagePath = join(work, a.name + '.html');
  writeFileSync(pagePath, page(a.w, a.h, a.body));

  for (let attempt = 0; attempt < 3; attempt++) {
    rmSync(out, { force: true });
    execFileSync(browser, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--hide-scrollbars', '--force-device-scale-factor=1',
      `--user-data-dir=${join(work, 'profile-' + a.name + '-' + attempt)}`,
      `--window-size=${a.w},${a.h}`,
      '--virtual-time-budget=2500',
      `--screenshot=${out}`,
      'file:///' + pagePath.split('\\').join('/')
    ], { stdio: 'ignore' });
    if (!existsSync(out)) continue;
    const b = readFileSync(out);
    if (b.readUInt32BE(16) !== a.w || b.readUInt32BE(20) !== a.h) continue;
    console.log(`✓ ${a.name}  ${a.w}x${a.h}  ${(b.length / 1024).toFixed(1)} KB`);
    break;
  }
  if (!existsSync(out)) console.error(`✗ ${a.name} 生成失败`);
}
