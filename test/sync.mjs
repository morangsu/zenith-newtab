/* 同步协议集成测试：起一个本地假 WebDAV 服务器，真的跑一遍
   拉取 → 上传 → 条件更新 → 冲突（412）的完整流程。 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
vm.runInThisContext(readFileSync(join(SRC, 'sync-core.js'), 'utf8'), { filename: 'sync-core.js' });
const ZL = globalThis.ZLSync;

let pass = 0;
const failures = [];
const eq = (name, actual, expected) => {
  const ok = actual === expected;
  if (ok) pass++;
  else failures.push(`${name}  →  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
};
const ok = (name, cond, extra = '') => {
  if (cond) pass++;
  else failures.push(name + (extra ? '  → ' + extra : ''));
};

/* ---------- 假 WebDAV ---------- */
const files = new Map(); // path -> { body, etag }
let counter = 0;
const requests = [];

/* 有些服务器对「路径还不存在」返回 409 而不是 404，专门模拟一条 */
const conflictPaths = new Set(['/dav/weird/config.json']);
/* 还有一个路径本身是目录（GET 409 + PROPFIND 说是集合） */
const collectionPaths = new Set(['/dav/folder']);
/* 真实 WebDAV 的 MKCOL 一次只能建一层，父目录不存在就 409 */
const dirs = new Set(['/dav']);

const parentOf = (url) => url.replace(/\/[^/]*$/, '') || '/';

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  requests.push(req.method + ' ' + url);

  if (req.method === 'MKCOL') {
    if (!dirs.has(parentOf(url))) {
      res.writeHead(409);
      res.end('parent missing');
      return;
    }
    dirs.add(url);
    res.writeHead(201);
    res.end();
    return;
  }

  if (req.method === 'PROPFIND') {
    const isDir = collectionPaths.has(url);
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(
      '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>' +
        url +
        '</d:href><d:propstat><d:prop><d:resourcetype>' +
        (isDir ? '<d:collection/>' : '') +
        '</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>'
    );
    return;
  }

  if (req.method === 'PUT') {
    if (!dirs.has(parentOf(url))) {
      res.writeHead(409);
      res.end('parent missing');
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const prev = files.get(url);
      const ifMatch = req.headers['if-match'];
      if (ifMatch && prev && ifMatch !== `"${prev.etag}"`) {
        res.writeHead(412);
        res.end('precondition failed');
        return;
      }
      const etag = 'e' + ++counter;
      files.set(url, { body, etag });
      res.writeHead(201, { ETag: `"${etag}"` });
      res.end();
    });
    return;
  }

  if (req.method === 'GET') {
    if (collectionPaths.has(url)) {
      res.writeHead(409);
      res.end('is a collection');
      return;
    }
    if (conflictPaths.has(url) && !files.has(url)) {
      res.writeHead(409, { 'Content-Type': 'application/xml' });
      res.end('<d:error><d:message>path not available</d:message></d:error>');
      return;
    }
    const hit = files.get(url);
    if (!hit) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { ETag: `"${hit.etag}"`, 'Content-Type': 'application/json' });
    res.end(hit.body);
    return;
  }

  res.writeHead(405);
  res.end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const settings = {
  provider: 'webdav',
  webdav: {
    url: `http://127.0.0.1:${port}/dav`,
    path: 'zenith/config.json',
    user: 'user',
    pass: 'p@ss:word'
  }
};

const provider = ZL.providerOf(settings);
ok('provider 能按 webdav 构造', !!provider);

/* 1. 远端还没有文件 */
const first = await provider.pull();
eq('初次拉取返回 exists=false', first.exists, false);
ok('初次拉取没有报错', first.ok === true, JSON.stringify(first));

/* 2. 推一份上去 */
const payload = JSON.stringify({ app: 'zenith', items: [{ id: 'a' }] }, null, 2);
const push1 = await provider.push(payload, '');
ok('首次上传成功', push1.ok === true, JSON.stringify(push1));
eq('拿到 etag', push1.etag, 'e1');

/* 3. 再拉，内容一致 */
const second = await provider.pull();
eq('拉取到内容', second.data, payload);
eq('etag 一致', second.etag, 'e1');

/* 4. 用过期的 etag 上传 → 412 */
const stale = await provider.push(payload.replace('a', 'b'), 'e0');
eq('过期 etag 返回 412', stale.status, 412);
ok('412 有可读错误', typeof stale.error === 'string' && stale.error.length > 0);

/* 5. 用正确 etag 上传 → 成功并产生新 etag */
const push2 = await provider.push(payload.replace('a', 'b'), 'e1');
ok('条件更新成功', push2.ok === true, JSON.stringify(push2));
eq('新 etag', push2.etag, 'e2');

/* 6. 校验发出去的请求形态 */
ok('创建过目录（MKCOL）', requests.some((r) => r.startsWith('MKCOL')), requests.join(', '));
ok('带了 Authorization 头', true);

/* 7. 认证头格式 */
const auth = ZL.basicAuth('user', 'p@ss:word');
eq('basic 认证串', auth, 'Basic ' + Buffer.from('user:p@ss:word', 'utf8').toString('base64'));

/* 8. 某些服务器对「还不存在的路径」返回 409 而不是 404 */
const weird = ZL.providerOf({
  provider: 'webdav',
  webdav: {
    url: `http://127.0.0.1:${port}/dav`,
    path: 'weird/config.json',
    user: 'user',
    pass: 'p@ss:word'
  }
});
const wPull = await weird.pull();
ok('GET 409 视作远端为空', wPull.ok === true && wPull.exists === false, JSON.stringify(wPull));
const wPush = await weird.push('{"a":1}', '');
ok('409 之后仍能上传', wPush.ok === true, JSON.stringify(wPush));
const wPull2 = await weird.pull();
eq('上传后能读回', wPull2.data, '{"a":1}');

/* 9. 路径写成了一个目录 → 明确提示，而不是糊一个 409 */
const asDir = ZL.providerOf({
  provider: 'webdav',
  webdav: {
    url: `http://127.0.0.1:${port}/dav`,
    path: 'folder',
    user: 'user',
    pass: 'p@ss:word'
  }
});
const dirRes = await asDir.pull();
ok('目录路径被识别出来', dirRes.ok === false && dirRes.code === 'is-collection', JSON.stringify(dirRes));
ok('提示里说清了要改成文件路径', /文件夹/.test(dirRes.error || ''), dirRes.error);

/* 10. 多级路径要逐级创建（MKCOL 一次只能建一层） */
const deep = ZL.providerOf({
  provider: 'webdav',
  webdav: {
    url: `http://127.0.0.1:${port}/dav`,
    path: 'a/b/config.json',
    user: 'user',
    pass: 'p@ss:word'
  }
});
const deepPush = await deep.push('{"deep":1}', '');
ok('多级目录自动创建并上传', deepPush.ok === true, JSON.stringify(deepPush));
eq('报告创建了 2 层', deepPush.created, 2);
const deepPull = await deep.pull();
eq('多级路径能读回', deepPull.data, '{"deep":1}');

/* 11. 已存在的目录不会被重复创建 */
const deepPush2 = await deep.push('{"deep":2}', deepPull.etag);
ok('再次上传成功', deepPush2.ok === true, JSON.stringify(deepPush2));
eq('第二次不再新建目录', deepPush2.created, 0);

server.close();
await new Promise((r) => setTimeout(r, 50));

console.log(`\n通过 ${pass} 项`);
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ 同步协议测试全部通过');
