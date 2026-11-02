/* 同步内核：经典脚本（非 module），同时被 Chromium 的 service worker
   和 Firefox 的事件页加载，因此挂在 globalThis.ZLSync 上。

   这里是整个扩展里唯一允许发网络请求的地方。页面侧一个网络 API 都没有，
   构建时会扫描源码树，除本文件外任何文件出现 fetch/XHR/WebSocket/sendBeacon 都直接失败。
   所以所有出网都必须经过后台，且只发往用户在设置里填的那一个地址。
*/
(function (root) {
  'use strict';

  /* ---------- 纯函数 ---------- */

  /* 稳定的 JSON 序列化：键排序，用于算哈希和比对 */
  function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    const keys = Object.keys(value).sort();
    return (
      '{' +
      keys
        .filter((k) => value[k] !== undefined)
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  }

  async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function basicAuth(user, pass) {
    const bytes = new TextEncoder().encode((user || '') + ':' + (pass || ''));
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return 'Basic ' + btoa(bin);
  }

  function joinUrl(base, path) {
    return String(base).replace(/\/+$/, '') + '/' + String(path).replace(/^\/+/, '');
  }

  function normalizeEtag(v) {
    if (!v) return '';
    return String(v).replace(/^W\//, '').replace(/"/g, '');
  }

  function originOf(url) {
    try {
      const u = new URL(url);
      return u.origin + '/*';
    } catch {
      return '';
    }
  }

  /* ---------- WebDAV ---------- */

  async function davFetch(settings, url, init) {
    const headers = Object.assign({}, init && init.headers, {
      Authorization: basicAuth(settings.user, settings.pass)
    });
    const res = await fetch(url, {
      method: (init && init.method) || 'GET',
      headers,
      body: init && init.body,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow'
    });
    return res;
  }

  /* 服务器报错时通常带一段 XML/HTML，截一小段放回错误里，比只有状态码有用 */
  async function snippet(res, max) {
    try {
      const text = await res.text();
      return String(text).replace(/\s+/g, ' ').trim().slice(0, max || 140);
    } catch {
      return '';
    }
  }

  /* 路径到底是文件、目录还是不存在——用 PROPFIND 问一次最准 */
  async function davProbeType(settings, url) {
    try {
      const res = await davFetch(settings, url, {
        method: 'PROPFIND',
        headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
        body:
          '<?xml version="1.0" encoding="utf-8"?>' +
          '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'
      });
      if (res.status === 207) {
        const body = await res.text();
        return /<[a-z0-9]+:collection/i.test(body) ? 'collection' : 'file';
      }
      if (res.status === 404) return 'missing';
      return 'unknown:' + res.status;
    } catch {
      return 'error';
    }
  }

  async function davPull(settings) {
    const url = joinUrl(settings.url, settings.path || 'zenith/config.json');
    const res = await davFetch(settings, url, { method: 'GET' });

    if (res.status === 404) return { ok: true, exists: false };

    /* 有些服务器（群晖、部分反代）对「路径不可用」返回 409 而不是 404。
       先问一次 PROPFIND：是目录就明确报错，不存在就当作还没文件。 */
    if (res.status === 409) {
      const kind = await davProbeType(settings, url);
      if (kind === 'collection') {
        return {
          ok: false,
          status: 409,
          code: 'is-collection',
          error:
            '这个地址指向一个文件夹而不是文件。请把「文件路径」改成具体文件，例如 zenith/config.json'
        };
      }
      return { ok: true, exists: false, note: 'GET 409/' + kind };
    }

    if (res.status === 401 || res.status === 403) {
      const body = await snippet(res);
      return {
        ok: false,
        status: res.status,
        error: `认证失败或没有权限${body ? '：' + body : ''}`
      };
    }
    if (!res.ok) {
      const body = await snippet(res);
      return { ok: false, status: res.status, error: `HTTP ${res.status}${body ? '：' + body : ''}` };
    }
    const text = await res.text();
    return { ok: true, exists: true, data: text, etag: normalizeEtag(res.headers.get('ETag')) };
  }

  /* WebDAV 的 MKCOL 一次只能建一层，所以从根往下逐级创建。
     已存在的层级会返回 405 或 409，都算正常。 */
  function dirParts(filePath) {
    const parts = String(filePath || 'zenith/config.json').split('/').filter(Boolean);
    parts.pop(); // 去掉文件名
    return parts;
  }

  async function davEnsureDirs(settings) {
    const base = String(settings.url || '').replace(/\/+$/, '');
    const parts = dirParts(settings.path);
    const created = [];
    const statuses = [];
    let cur = base;

    for (const name of parts) {
      cur += '/' + encodeURIComponent(name);
      let status = 0;
      try {
        const res = await davFetch(settings, cur, { method: 'MKCOL' });
        status = res.status;
      } catch {
        status = 0;
      }
      statuses.push(status);
      if (status === 201) created.push(name);
      /* 201 新建、405/409 已存在；其它状态说明这层建不出来，后面也不用试了 */
      if (![201, 405, 409].includes(status)) break;
    }

    return { created, statuses };
  }

  async function davPush(settings, text, etag) {
    const url = joinUrl(settings.url, settings.path || 'zenith/config.json');
    let ensure = { created: [], statuses: [] };
    if (!etag) ensure = await davEnsureDirs(settings);

    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (etag) headers['If-Match'] = '"' + etag + '"';

    let res = await davFetch(settings, url, { method: 'PUT', headers, body: text });

    /* 目录被删过的情况：补建后重试一次 */
    if (res.status === 409 && etag) {
      ensure = await davEnsureDirs(settings);
      const retryHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
      res = await davFetch(settings, url, { method: 'PUT', headers: retryHeaders, body: text });
    }

    if (res.status === 412) return { ok: false, status: 412, error: '远端已被别处修改' };
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, error: '认证失败' };
    if (res.status === 409) {
      const body = await snippet(res);
      return {
        ok: false,
        status: 409,
        error:
          `路径不可写（建目录结果 ${ensure.statuses.join('/') || '未尝试'}）` +
          `${body ? '：' + body : ''}，检查地址与文件路径是否匹配`
      };
    }
    if (res.status === 429) return { ok: false, status: 429, error: '请求过于频繁，稍后再试' };
    if (!res.ok) {
      const body = await snippet(res);
      return { ok: false, status: res.status, error: `HTTP ${res.status}${body ? '：' + body : ''}` };
    }

    return {
      ok: true,
      etag: normalizeEtag(res.headers.get('ETag')),
      created: ensure.created.length
    };
  }

  /* ---------- GitHub（只传配置，不传任何图片） ---------- */

  function ghParts(settings) {
    const repo = String(settings.repo || '').trim();
    const path = String(settings.path || 'zenith/config.json').replace(/^\/+/, '');
    return { repo, path, branch: settings.branch || 'main' };
  }

  function ghHeaders(settings) {
    return {
      Authorization: 'Bearer ' + (settings.token || ''),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  function decodeBase64Utf8(b64) {
    const bin = atob(String(b64).replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  async function ghPull(settings) {
    const { repo, path, branch } = ghParts(settings);
    if (!repo || !settings.token) return { ok: false, error: '仓库或令牌为空' };
    const url =
      `https://api.github.com/repos/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`;
    const res = await fetch(url, { headers: ghHeaders(settings), cache: 'no-store' });
    if (res.status === 404) return { ok: true, exists: false };
    if (res.status === 401) return { ok: false, status: 401, error: '令牌无效或已过期' };
    if (!res.ok) return { ok: false, status: res.status, error: 'HTTP ' + res.status };
    const json = await res.json();
    return {
      ok: true,
      exists: true,
      data: decodeBase64Utf8(json.content || ''),
      etag: json.sha
    };
  }

  async function ghPush(settings, text, sha) {
    const { repo, path, branch } = ghParts(settings);
    if (!repo || !settings.token) return { ok: false, error: '仓库或令牌为空' };
    const url = `https://api.github.com/repos/${repo}/contents/${encodeURI(path)}`;
    const body = {
      message: 'zenith: 同步配置',
      content: encodeBase64Utf8(text),
      branch
    };
    if (sha) body.sha = sha;

    const res = await fetch(url, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(settings)),
      body: JSON.stringify(body),
      cache: 'no-store'
    });

    if (res.status === 409) return { ok: false, status: 409, error: '远端已被别处修改' };
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, error: '令牌权限不足' };
    if (res.status === 404) return { ok: false, status: 404, error: '仓库或分支不存在' };
    if (res.status === 422) return { ok: false, status: 422, error: '文件过大或路径非法' };
    if (!res.ok) return { ok: false, status: res.status, error: 'HTTP ' + res.status };

    const json = await res.json();
    return { ok: true, etag: json.content && json.content.sha };
  }

  /* 连通性探测：只用来判断「域名通不通」，不读内容 */
  async function probe(url, headers) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: headers || {},
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'follow'
      });
      return { reachable: true, status: res.status, ms: Date.now() - started };
    } catch (e) {
      return { reachable: false, error: (e && e.message) || '网络错误', ms: Date.now() - started };
    }
  }

  /* ---------- 统一入口 ---------- */

  function providerOf(settings) {
    if (settings.provider === 'webdav' && settings.webdav) {
      const cfg = settings.webdav;
      return { pull: () => davPull(cfg), push: (text, etag) => davPush(cfg, text, etag) };
    }
    if (settings.provider === 'github' && settings.github) {
      const cfg = settings.github;
      return { pull: () => ghPull(cfg), push: (text, etag) => ghPush(cfg, text, etag) };
    }
    return null;
  }

  const ZLSync = {
    canonical,
    sha256Hex,
    basicAuth,
    joinUrl,
    normalizeEtag,
    originOf,
    davPull,
    davPush,
    ghPull,
    ghPush,
    probe,
    providerOf
  };

  root.ZLSync = ZLSync;
})(typeof globalThis !== 'undefined' ? globalThis : self);
