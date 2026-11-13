/* 归档：把源码快照与开发期探针打包到 archive/，并生成带 sha256 的清单。
   运行：node tools/archive.mjs */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, cpSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { zipDir } from './zip.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WS = resolve(ROOT, '..');
const OUT = join(ROOT, 'archive');
/* 版本唯一真相在 manifests，别再在这里硬编码 */
const VERSION = JSON.parse(readFileSync(join(ROOT, 'manifests', 'chrome.json'), 'utf8')).version;
const DATE = new Date().toISOString().slice(0, 10);

mkdirSync(OUT, { recursive: true });

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const lines = [`# Zenith 归档清单（${DATE}）`, '', `版本：${VERSION}`, ''];

/* 1. 源码快照：仓库除 dist 与 archive 外的全部内容 */
const tmp = join(ROOT, '.archive-stage');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
for (const name of ['src', 'test', 'tools', 'docs', 'manifests', 'bench', 'build.mjs', 'package.json', 'README.md', 'PRIVACY.md', 'LICENSE']) {
  const from = join(ROOT, name);
  if (existsSync(from)) cpSync(from, join(tmp, name), { recursive: true });
}

const srcZip = join(OUT, `zenith-source-${VERSION}.zip`);
const { buffer: srcBuf, count: srcCount } = zipDir(tmp, { exclude: [] });
writeFileSync(srcZip, srcBuf);
lines.push(
  `## zenith-source-${VERSION}.zip`,
  '',
  `- 内容：完整源码（src / test / tools / docs / manifests / bench / 构建脚本 / README / PRIVACY / LICENSE）`,
  `- 文件数：${srcCount}`,
  `- sha256：\`${sha256(srcBuf)}\``,
  `- 用途：AMO 源码备查、长期留档。构建方式见 README（node build.mjs --zip）。`,
  ''
);
rmSync(tmp, { recursive: true, force: true });

/* 2. favicon-probe（开发期探针，位于工作区根目录） */
const probeDir = join(WS, 'favicon-probe');
if (existsSync(probeDir)) {
  const probeZip = join(OUT, 'favicon-probe-0.1.0.zip');
  const { buffer: probeBuf, count: probeCount } = zipDir(probeDir, { exclude: [] });
  writeFileSync(probeZip, probeBuf);
  lines.push(
    `## favicon-probe-0.1.0.zip`,
    '',
    `- 内容：开发期 Firefox 图标格式探针（用于设计 Firefox 图标捕获方案，已完成任务）`,
    `- 文件数：${probeCount}`,
    `- sha256：\`${sha256(probeBuf)}\``,
    ''
  );
}

/* 3. 商店包（引用 dist 下的现成产物及其 sha256） */
lines.push(`## 商店包（存于 dist/，此处登记校验值）`, '');
for (const name of [`chrome-${VERSION}.zip`, `firefox-${VERSION}.xpi`]) {
  const p = join(ROOT, 'dist', name);
  if (existsSync(p)) {
    lines.push(`- dist/${name}　sha256：\`${sha256(readFileSync(p))}\``);
  }
}
const sidecars = existsSync(join(ROOT, 'dist')) ? readdirSync(join(ROOT, 'dist')).filter((f) => f.endsWith('.sha256')) : [];
for (const s of sidecars) {
  lines.push(`- dist/${s}（校验文件）`);
}
lines.push('');

/* 4. 性能对比数据（随源码快照一起归档，保证结论可复现） */
const compare = join(ROOT, 'bench', 'COMPARE.md');
lines.push(`## 性能对比（bench/）`, '');
if (existsSync(compare)) lines.push(`- bench/COMPARE.md　sha256：\`${sha256(readFileSync(compare))}\``);
lines.push(
  `- bench/before.json / before2.json：0.12.0 基线（before2 与 after2 为同环境对照）`,
  `- bench/after.json / after2.json：0.13.0 首版 / 优化后最终版`,
  `- bench/baseline-dist/chrome：0.12.0 构建快照，用于复现基线`,
  `- 复现：node test/bench.mjs --label X --ext <目录> --rounds 12，再 --report A.json B.json`,
  ''
);

/* 5. 当前状态摘要 */
lines.push(
  `## 当前状态`,
  '',
  `- 已上架：Edge Add-ons（0.11.2 过审；${VERSION} 更新包已备好，待人工提交）`,
  `- 进行中：Firefox AMO（0.11.3 已过验证；${VERSION} 待上传）`,
  `- Chrome Web Store：未提交（收费，暂不上）`,
  `- ${VERSION} 变更：仅 Firefox manifest 增加 chrome_settings_overrides.homepage，` +
    `让启动首页 / 新窗口也显示 Zenith；Chromium 端不加该字段；补构建守卫与 AMO 披露`,
  `- 0.13.0 变更：完整 i18n（中/英可切换）、本地快照与回滚、同步差异预览与覆盖前自动备份、`,
  `  组件配置协议、存储配额与孤立资源回收、壁纸轮播 / 时段主题 / 键盘可达性、`,
  `  设置面板按需加载、首屏/页面双层体积预算、虚拟双设备同步回归、图标删除传播修复`,
  `- 性能：首屏静态链路 72.4 → 68.6 KB，热启动 32.6 → 29.8 ms，首屏 DOM 229 → 113（详见 bench/COMPARE.md）`,
  `- 测试：npm test 共 595 项（smoke 164 / sync 24 / features 336 / dual-device 71）；` +
    `另有 layout 7、vision 7、e2e 24 需真实浏览器`,
  ''
);

writeFileSync(join(OUT, `MANIFEST-${VERSION}.md`), lines.join('\n'));
console.log(`✓ 归档完成 → ${OUT}`);
console.log(`  zenith-source-${VERSION}.zip  ${(srcBuf.length / 1024).toFixed(1)} KB / ${srcCount} 文件`);
if (existsSync(join(OUT, 'favicon-probe-0.1.0.zip'))) console.log(`  favicon-probe-0.1.0.zip`);
console.log(`  MANIFEST-${VERSION}.md`);
