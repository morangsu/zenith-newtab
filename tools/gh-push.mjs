#!/usr/bin/env node
/**
 * gh-push.mjs — 不依赖 git 传输协议，用 GitHub REST API 把本地 git 索引推成一个提交。
 *
 * 为什么需要它：本机到 github.com:443 被代理挡住（git 的 smart-HTTP / ssh 都走不通），
 * 但 api.github.com 可达。Git Data API（blobs → tree → commit → ref）一次提交写完全部
 * 文件，远程历史保持连续（parent = 远程 main 的 HEAD）。
 *
 * 用法：
 *   GH_TOKEN=xxx node tools/gh-push.mjs [选项]
 *
 * 选项：
 *   --repo <owner/name>   默认 morangsu/zenith-newtab
 *   --message <text>      提交信息，默认 "chore: sync"
 *   --tag <vX.Y.Z>        提交成功后创建轻量 tag（已存在则跳过并提示）
 *   --dry-run             只列出要推的文件，不发任何请求
 *
 * 文件清单取自 `git ls-files`，.gitignore 生效；内容取 git 索引里的 blob（不是工作区），
 * 因此与 .gitattributes 的 `* -text` 配合后，推上去的字节与工作区逐字节一致。
 * 令牌只从环境变量读取，绝不写入仓库或配置文件。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.github.com';
const TOKEN = process.env.GH_TOKEN;
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes('--' + name);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = arg('repo', 'morangsu/zenith-newtab');
const MESSAGE = arg('message', 'chore: sync');
const TAG = arg('tag', '');

if (!TOKEN && !has('dry-run')) {
  console.error('缺少 GH_TOKEN 环境变量（令牌只从环境读取，不会落盘）');
  process.exit(1);
}

async function api(method, url, body) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url.startsWith('http') ? url : API + url, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (res.ok) return { status: res.status, data };
    // 409/422 是业务结论，不重试；429/5xx 才退避
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      return { status: res.status, data };
    }
    if (attempt === 4) return { status: res.status, data };
    const wait = 500 * 2 ** (attempt - 1);
    console.error(`  ! ${method} ${url} → ${res.status}，${wait}ms 后重试`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

function listTracked() {
  const out = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: ROOT, maxBuffer: 1 << 28 });
  return out.toString('utf8').split('\0').filter(Boolean).map((rec) => {
    const tab = rec.indexOf('\t');
    const head = rec.slice(0, tab).split(' ');
    return {
      mode: head[0] === '100755' ? '100755' : '100644',
      sha: head[1],
      path: rec.slice(tab + 1)
    };
  });
}

const files = listTracked();
if (!files.length) {
  console.error('git 索引里没有文件，先 git add');
  process.exit(1);
}
console.log(`仓库 ${SLUG}：${files.length} 个文件`);

if (has('dry-run')) {
  for (const f of files) console.log('  ' + f.path);
  console.log(`（dry-run，未发送请求；tag=${TAG || '无'}）`);
  process.exit(0);
}

// 1) blobs。返回 sha 必须与 git 索引里的 blob sha 一致，否则说明字节被改过。
const CONCURRENCY = 6;
const treeEntries = [];
let done = 0, bytes = 0;
const queue = [...files];
async function worker() {
  while (queue.length) {
    const entry = queue.shift();
    const buf = execFileSync('git', ['cat-file', 'blob', entry.sha], {
      cwd: ROOT, maxBuffer: 1 << 28
    });
    const r = await api('POST', `/repos/${SLUG}/git/blobs`, {
      content: buf.toString('base64'),
      encoding: 'base64'
    });
    if (r.status !== 201) {
      throw new Error(`blob 失败 ${entry.path}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    }
    if (r.data.sha !== entry.sha) {
      throw new Error(`字节不一致 ${entry.path}: git=${entry.sha} GitHub=${r.data.sha}（检查换行转换）`);
    }
    treeEntries.push({ path: entry.path, mode: entry.mode, type: 'blob', sha: r.data.sha });
    bytes += buf.length;
    done++;
    if (done % 20 === 0 || done === files.length) {
      process.stdout.write(`\r  blobs ${done}/${files.length}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker())).catch((e) => {
  console.error('\n' + e.message);
  process.exit(1);
});
console.log(`\n  ${(bytes / 1048576).toFixed(2)} MiB，blob sha 全部与本地一致`);

// 2) tree
const treeRes = await api('POST', `/repos/${SLUG}/git/trees`, { tree: treeEntries });
if (treeRes.status !== 201) {
  console.error(`tree 失败: ${treeRes.status} ${JSON.stringify(treeRes.data).slice(0, 300)}`);
  process.exit(1);
}
console.log(`  tree ${treeRes.data.sha.slice(0, 10)}`);

// 3) commit，parent = 远程 main HEAD
const refRes = await api('GET', `/repos/${SLUG}/git/ref/heads/main`);
if (refRes.status !== 200) {
  console.error(`读 main 失败: ${refRes.status} ${JSON.stringify(refRes.data).slice(0, 300)}`);
  process.exit(1);
}
const parent = refRes.data.object.sha;
const commitRes = await api('POST', `/repos/${SLUG}/git/commits`, {
  message: MESSAGE,
  tree: treeRes.data.sha,
  parents: [parent]
});
if (commitRes.status !== 201) {
  console.error(`commit 失败: ${commitRes.status} ${JSON.stringify(commitRes.data).slice(0, 300)}`);
  process.exit(1);
}
const commitSha = commitRes.data.sha;

// 4) 更新 main
const upd = await api('PATCH', `/repos/${SLUG}/git/refs/heads/main`, {
  sha: commitSha, force: false
});
if (upd.status !== 200) {
  console.error(`ref 更新失败: ${upd.status} ${JSON.stringify(upd.data).slice(0, 300)}`);
  process.exit(1);
}

// 5) tag（轻量 tag 直接指向这个 commit）
if (TAG) {
  const tagRes = await api('POST', `/repos/${SLUG}/git/refs`, {
    ref: 'refs/tags/' + TAG,
    sha: commitSha
  });
  if (tagRes.status === 201) console.log(`  tag  ${TAG} → ${commitSha.slice(0, 10)}`);
  else console.log(`  tag  ${TAG} 未创建（${tagRes.status} ${tagRes.data.message || '已存在?'}）`);
}

console.log(`✓ https://github.com/${SLUG}/commit/${commitSha}`);
console.log(`  ${MESSAGE.split('\n')[0]}`);
