/* 仅用于本地预览/自动化检查的静态服务器：node test/serve.mjs [port] [dir] */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist/chrome', import.meta.url));
const PORT = Number(process.argv[2] || 8787);
const DIR = process.argv[3] || ROOT;

/* 把扩展的 CSP 原样作为响应头下发，用来在普通浏览器里等价验证策略是否会打断页面 */
let CSP = '';
try {
  const mf = JSON.parse(await readFile(join(DIR, 'manifest.json'), 'utf8'));
  CSP = mf.content_security_policy?.extension_pages || '';
} catch {
  /* 没有 manifest 就不加头 */
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

createServer(async (req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = normalize(url === '/' ? '/newtab.html' : url).replace(/^([/\\])+/, '');
  const file = join(DIR, rel);
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    const headers = {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store'
    };
    if (CSP && extname(file) === '.html') headers['content-security-policy'] = CSP;
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('404');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${DIR} → http://127.0.0.1:${PORT}/newtab.html`);
});
