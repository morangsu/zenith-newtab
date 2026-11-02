// 把 src/icon.svg 渲染成各尺寸 PNG。
// 用浏览器矢量渲染而不是位图缩放——16px 下轮廓更清楚。
// 只在本机生成时运行（不是构建的一部分），产物已提交到 src/icons/。
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'src', 'icons');
const SIZES = [16, 32, 48, 96, 128];

const CANDIDATES = [
  process.env.EDGE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);

const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error('找不到 Chrome/Edge，可用 EDGE_PATH 环境变量指定');
  process.exit(1);
}

const rawSvg = readFileSync(join(ROOT, 'src', 'icon.svg'), 'utf8');

/* 注意：不要用 svg{width:100vw;height:100vh} 自适应。
   实测窗口 ≥96px 时浏览器算出的 svg 尺寸会失效，整张图不绘制（截图一片空白）。
   每个尺寸单独写死 width/height，仍然是矢量渲染，不是位图缩放。 */
const pageFor = (size) => {
  const svg = rawSvg.replace(/<svg([^>]*)>/, `<svg$1 width="${size}" height="${size}">`);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden}
svg{display:block}
</style></head><body>${svg}</body></html>`;
};

const work = join(tmpdir(), 'zenith-icons');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

mkdirSync(OUT, { recursive: true });

for (const size of SIZES) {
  const out = join(OUT, `icon${size}.png`);
  const page = join(work, `icon-${size}.html`);
  writeFileSync(page, pageFor(size));

  let buf = null;
  /* 连续快速起浏览器时，靠后的实例偶尔会截出空白（进程还没把首帧提交上去）。
     尺寸或内容不对就重试一次，这是生成脚本，多花一秒比出坏图好。 */
  for (let attempt = 0; attempt < 3; attempt++) {
    rmSync(out, { force: true });
    execFileSync(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--default-background-color=00000000',
        `--user-data-dir=${join(work, 'profile-' + size + '-' + attempt)}`,
        `--window-size=${size},${size}`,
        '--virtual-time-budget=2500',
        `--screenshot=${out}`,
        'file:///' + page.split('\\').join('/')
      ],
      { stdio: 'ignore' }
    );
    if (!existsSync(out)) continue;
    const b = readFileSync(out);
    if (b.readUInt32BE(16) !== size || b.readUInt32BE(20) !== size) continue;
    if (b.length < 500) continue; // 空白图压缩后极小
    buf = b;
    break;
  }

  if (!buf) {
    console.error(`✗ icon${size}.png 生成失败（多次重试仍为空白）`);
    process.exit(1);
  }
  console.log(`✓ icon${size}.png  ${buf.length} 字节`);
}

rmSync(work, { recursive: true, force: true });
