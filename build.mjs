// 可复现构建：无第三方依赖，只做「复制 + 生成 manifest + 指纹校验」。
// 所有输出文件的 mtime 被固定，保证同一份源码任何时候构建出的字节流完全一致。
import {
  readdirSync, statSync, mkdirSync, rmSync, copyFileSync,
  writeFileSync, utimesSync, readFileSync, existsSync
} from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const FIXED_MTIME = new Date('2021-01-01T00:00:00Z');
const BUDGET_PAGE = 72 * 1024;
const BUDGET_BG = 16 * 1024;
const BG_FILES = new Set(['background.js', 'sync-core.js']);
const IS_ICON = (rel) => rel.startsWith('icons/') || rel === 'icon.svg';

const TARGETS = [
  { key: 'chrome', manifest: 'chrome.json', exclude: [] },
  { key: 'firefox', manifest: 'firefox.json', exclude: [] }
];

/* MV3 的 extension_pages CSP 同时作用于 service worker，所以 connect-src 不能是 'none'，
   否则后台的 fetch 也会被拦（表现为所有请求 Failed to fetch）。
   页面侧不联网改用构建期扫描保证：除 sync-core.js 外任何文件出现网络 API 直接失败。 */
const REQUIRED_CSP = ["script-src 'self'", "object-src 'none'", 'connect-src https:', 'http:'];
const FORBIDDEN_PERMISSIONS = ['<all_urls>', 'history', 'cookies', 'webRequest', 'declarativeNetRequest'];
const ALWAYS_BANNED = [
  { re: /\beval\s*\(/g, why: '动态执行' },
  { re: /new\s+Function/g, why: '动态执行' }
];
const NETWORK_APIS = [
  { re: /\bfetch\s*\(/g, why: '网络请求' },
  { re: /XMLHttpRequest/g, why: '网络请求' },
  { re: /\bWebSocket\b/g, why: '网络请求' },
  { re: /sendBeacon/g, why: '网络请求' }
];
/* 只有同步内核允许发请求，其余任何文件出现网络 API 都让构建失败 */
const NETWORK_ALLOWED = new Set(['sync-core.js']);

const fail = (msg) => { console.error('✗ ' + msg); process.exit(1); };
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walk(abs, base));
    else out.push(relative(base, abs).split('\\').join('/'));
  }
  return out;
}

if (!existsSync(SRC)) fail('找不到 src/ 目录');

// ---------- 守卫 1：源码里不允许出现任何联网或动态执行 API ----------
const srcFiles = walk(SRC);
const violations = [];
for (const rel of srcFiles) {
  if (!/\.(js|html|css)$/.test(rel)) continue;
  const text = readFileSync(join(SRC, rel), 'utf8');
  const checks = NETWORK_ALLOWED.has(rel)
    ? ALWAYS_BANNED
    : ALWAYS_BANNED.concat(NETWORK_APIS);
  for (const { re, why } of checks) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const line = text.slice(0, m.index).split('\n').length;
      violations.push(`${rel}:${line} 出现 ${why} (${m[0].trim()})`);
    }
  }
}
if (violations.length) fail('源码包含被禁止的 API：\n  ' + violations.join('\n  '));

// ---------- 守卫 2：manifest 的 CSP 与权限 ----------
for (const t of TARGETS) {
  const mf = JSON.parse(readFileSync(join(ROOT, 'manifests', t.manifest), 'utf8'));
  const csp = mf?.content_security_policy?.extension_pages || '';
  for (const need of REQUIRED_CSP) if (!csp.includes(need)) fail(`${t.key} 的 CSP 缺少 "${need}"`);
  const allPerms = [...(mf.permissions || []), ...(mf.optional_permissions || []), ...(mf.host_permissions || [])];
  for (const bad of FORBIDDEN_PERMISSIONS) if (allPerms.includes(bad)) fail(`${t.key} 声明了禁用权限 ${bad}`);
  if (t.key === 'chrome' && allPerms.includes('tabs')) fail('chrome 版本不应声明 tabs（改用 _favicon，无需该权限）');
  if (!mf.chrome_url_overrides?.newtab) fail(`${t.key} 缺少 chrome_url_overrides.newtab`);
  if (!mf.icons || !mf.icons['128']) fail(`${t.key} 缺少 128px 图标`);
  if (t.key === 'firefox' && !mf.icons['96']) fail('firefox 版本需要 96px 图标');
  if (!mf.action) fail(`${t.key} 缺少 action（工具栏按钮）`);
}

// ---------- 守卫 3：图标文件必须存在且尺寸与声明一致 ----------
const iconFiles = new Map();
for (const t of TARGETS) {
  const mf = JSON.parse(readFileSync(join(ROOT, 'manifests', t.manifest), 'utf8'));
  const declared = { ...(mf.icons || {}), ...((mf.action && mf.action.default_icon) || {}) };
  for (const [size, rel] of Object.entries(declared)) {
    const abs = join(SRC, rel);
    if (!existsSync(abs)) fail(`${t.key} 引用的图标不存在：${rel}（先跑 node tools/render-icons.mjs）`);
    if (!iconFiles.has(rel)) {
      const buf = readFileSync(abs);
      if (buf.readUInt32BE(0) !== 0x89504e47) fail(`${rel} 不是 PNG`);
      iconFiles.set(rel, { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
    }
    const { w, h } = iconFiles.get(rel);
    if (w !== Number(size) || h !== Number(size)) {
      fail(`${rel} 实际为 ${w}×${h}，manifest 声明为 ${size}×${size}`);
    }
  }
}

// ---------- 守卫 4：两个平台的版本号必须一致 ----------
{
  const versions = TARGETS.map((t) => JSON.parse(readFileSync(join(ROOT, 'manifests', t.manifest), 'utf8')).version);
  if (new Set(versions).size !== 1) fail(`manifest 版本不一致：${versions.join(' / ')}`);
  const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  if (pkgVersion !== versions[0]) fail(`package.json 版本 ${pkgVersion} 与 manifest ${versions[0]} 不一致`);
}

// ---------- 构建 ----------
if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
const manifestBytes = {};

for (const t of TARGETS) {
  const outDir = join(DIST, t.key);
  mkdirSync(outDir, { recursive: true });

  for (const rel of srcFiles) {
    if ((t.exclude || []).includes(rel)) continue;
    const to = join(outDir, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(SRC, rel), to);
    utimesSync(to, FIXED_MTIME, FIXED_MTIME);
  }

  const raw = readFileSync(join(ROOT, 'manifests', t.manifest));
  const mfText = JSON.stringify(JSON.parse(raw.toString('utf8')), null, 2) + '\n';
  manifestBytes[t.key] = Buffer.from(mfText, 'utf8');
  const mfPath = join(outDir, 'manifest.json');
  writeFileSync(mfPath, manifestBytes[t.key]);
  utimesSync(mfPath, FIXED_MTIME, FIXED_MTIME);

  /* 版本号只在 manifest 里维护一份，构建时生成一个模块给页面用 */
  const versionFile = join(outDir, 'js', 'version.js');
  mkdirSync(dirname(versionFile), { recursive: true });
  writeFileSync(
    versionFile,
    `export const VERSION = ${JSON.stringify(JSON.parse(mfText).version)};\n`
  );
  utimesSync(versionFile, FIXED_MTIME, FIXED_MTIME);
}

// ---------- 报告 + 指纹 ----------
let totalGzip = 0;
let worstPage = 0;
let worstBg = 0;
console.log('\n构建产物');
console.log('─'.repeat(58));
for (const t of TARGETS) {
  const outDir = join(DIST, t.key);
  const files = walk(outDir);
  let gz = 0;
  let page = 0;
  let bg = 0;
  let icons = 0;
  for (const rel of files) {
    const size = gzipSync(readFileSync(join(outDir, rel))).length;
    gz += size;
    /* 图标是预压缩的 PNG，且不在首屏链路上（只有浏览器读 manifest 时用），
       单独记账，不计入首屏预算 */
    if (IS_ICON(rel)) icons += size;
    else if (BG_FILES.has(rel)) bg += size;
    else page += size;
  }
  worstPage = Math.max(worstPage, page);
  worstBg = Math.max(worstBg, bg);
  totalGzip += gz;
  const lines = files.map((rel) => {
    const size = statSync(join(outDir, rel)).size;
    return `${rel.padEnd(24)} ${String(size).padStart(8)} B${IS_ICON(rel) ? '  (图标，不计预算)' : ''}`;
  });
  console.log(
    `\n[${t.key}] ${files.length} 个文件　页面 ${(page / 1024).toFixed(1)} KB / 后台 ${(bg / 1024).toFixed(1)} KB（gzip）　图标另计 ${(icons / 1024).toFixed(1)} KB`
  );
  for (const l of lines) console.log('  ' + l);

  const fp = sha(
    files.sort().map((rel) => `${rel}:${sha(readFileSync(join(outDir, rel)))}`).join('\n')
  );
  writeFileSync(join(outDir, 'BUILD.txt'),
    `target: ${t.key}\nsource-fingerprint: ${fp}\nnode: ${process.version}\nfiles: ${files.length}\n`);
  console.log(`  fingerprint ${fp.slice(0, 16)}…`);
}
console.log('─'.repeat(58));

if (worstPage > BUDGET_PAGE) {
  fail(`页面 gzip ${(worstPage / 1024).toFixed(1)} KB，超出预算 ${BUDGET_PAGE / 1024} KB`);
}
if (worstBg > BUDGET_BG) {
  fail(`后台 gzip ${(worstBg / 1024).toFixed(1)} KB，超出预算 ${BUDGET_BG / 1024} KB`);
}
console.log(
  `✓ 体积预算通过：页面 ${(worstPage / 1024).toFixed(1)} / ${BUDGET_PAGE / 1024} KB　` +
    `后台 ${(worstBg / 1024).toFixed(1)} / ${BUDGET_BG / 1024} KB`
);

// ---------- 可选打包 ----------
if (process.argv.includes('--zip')) {
  const { zipDir } = await import('./tools/zip.mjs');
  for (const t of TARGETS) {
    const outDir = join(DIST, t.key);
    const ext = t.key === 'firefox' ? 'xpi' : 'zip';
    const zipPath = join(DIST, `${t.key}-${JSON.parse(manifestBytes[t.key]).version}.${ext}`);
    const { buffer, count } = zipDir(outDir, { exclude: ['BUILD.txt'] });
    writeFileSync(zipPath, buffer);
    const hash = sha(buffer);
    writeFileSync(join(DIST, `${t.key}.sha256`), `${hash}  ${zipPath.split(/[\\/]/).pop()}\n`);
    console.log(
      `✓ 打包 ${zipPath.split(/[\\/]/).pop()}  ${count} 个文件 / ${(buffer.length / 1024).toFixed(1)} KB  sha256 ${hash.slice(0, 16)}…`
    );
  }
}
