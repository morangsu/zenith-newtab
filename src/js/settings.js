/* 设置面板：壁纸 / 主题 / 字号 / 显示 / 搜索引擎 / 站点 / 图标 / 诊断。
   全部本地操作，唯二涉及权限的动作是「导入书签」和 Firefox 的「启用图标捕获」。 */
import { IS_FIREFOX, ext, normalizeUrl, hostOf } from './util.js';
import { uid, linksOf, veilOf } from './store.js';
import { ENGINES } from './search.js';
import {
  saveWallpaperBlob,
  saveWallpaperShot,
  clearWallpaperShot,
  enableFirefoxCapture,
  hasTabsPermission,
  countCachedIcons
} from './favicon.js';
import { clearIconUrlCache } from './iconview.js';
import { idbClear, STORE_ICONS } from './idb.js';
import { flattenBookmarks } from './bookmarks.js';
import {
  loadSettings,
  saveSettings,
  loadMeta,
  syncNow,
  testConnection,
  diagnose,
  requestOrigin,
  hasOrigin,
  MIN_INTERVAL
} from './sync.js';
import { buildPack, downloadPack, importPack } from './pack.js';
import { VERSION } from './version.js';

const PRESETS = [
  { id: 'ink', name: '墨', light: '#f4f3ef', dark: '#16181c' },
  { id: 'sage', name: '苔', light: '#edf2ea', dark: '#16211d' },
  { id: 'dusk', name: '暮', light: '#f2eff7', dark: '#191625' },
  {
    id: 'aurora',
    name: '极光',
    light: 'linear-gradient(158deg,#eef2ff,#f6eef8 52%,#e9f6f0)',
    dark: 'linear-gradient(158deg,#0f1526,#1a1226 52%,#0c1e1b)'
  },
  {
    id: 'dawn',
    name: '晨',
    light: 'linear-gradient(148deg,#fff4e8,#fce9e9 58%,#f3e9ff)',
    dark: 'linear-gradient(148deg,#231a12,#291418 58%,#1c1424)'
  },
  {
    id: 'moss',
    name: '苔原',
    light: 'linear-gradient(132deg,#eef5e5,#e1eee7)',
    dark: 'linear-gradient(132deg,#111f19,#0e1a21)'
  }
];

function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

const isDarkNow = () => {
  const root = document.documentElement;
  const forced = root.getAttribute('data-theme');
  if (forced === 'dark') return true;
  if (forced === 'light') return false;
  /* 自动配色会按壁纸把整体翻面，预设色块的预览也要跟着翻，
     否则页面是浅色画面，色块列表却全显示深色版 */
  const adapt = root.getAttribute('data-adapt');
  if (adapt === 'dark') return true;
  if (adapt === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

function compressImage(file, maxWidth = 2560) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const w = Math.max(1, Math.round(img.width * scale));
      const hgt = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = hgt;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, hgt);
      canvas.toBlob((blob) => resolve(blob), 'image/webp', 0.86);
    };
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = URL.createObjectURL(file);
  });
}

export function mountSettings({ store, search, onBookmarks, onIconsChanged, onDisplayChange, onLayoutChange }) {
  const { state } = store;
  const panel = document.getElementById('panel');
  const gear = document.getElementById('gear');
  const bgEl = document.getElementById('bg');
  const root = document.documentElement;

  let syncDraft = null;
  let syncMeta = null;
  let syncGranted = false;

  /* 遮罩滑块每次 render 都会重建，用引用记住它，切换壁纸时同步回显 */
  let veilSlider = null;
  let veilLabelEl = null;

  function currentVeil() {
    return veilOf(state.wallpaper, state.theme && state.theme.mode);
  }

  function syncVeilUi() {
    const v = currentVeil();
    root.style.setProperty('--veil-a', String(v));
    if (veilSlider) veilSlider.value = String(v);
    if (veilLabelEl) veilLabelEl.textContent = Math.round(v * 100) + '%';
  }

  function applyTheme(mode) {
    if (mode === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
  }

  function applyPreset(id) {
    root.setAttribute('data-wallpaper', id);
    root.setAttribute('data-wall', 'preset');
    bgEl.style.backgroundImage = '';
    root.style.backgroundImage = '';
    /* 预设不吃首帧缓存，清掉省空间；切回图片时主流程会重新生成 */
    clearWallpaperShot();
    syncVeilUi();
  }

  function closePanel() {
    panel.hidden = true;
    panel.textContent = '';
  }

  async function openPanel() {
    syncDraft = await loadSettings();
    syncMeta = await loadMeta();
    const origin = originForDraft(syncDraft);
    syncGranted = origin ? await hasOrigin(origin) : false;
    panel.hidden = false;
    render();
  }

  gear.addEventListener('click', openPanel);
  panel.addEventListener('click', (e) => {
    if (e.target === panel) closePanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) closePanel();
  });

  async function importBookmarks() {
    if (!ext || !ext.permissions) return;
    const granted = await ext.permissions.request({ permissions: ['bookmarks'] });
    if (!granted) return;
    const list = await flattenBookmarks();
    if (!list.length) return;
    onBookmarks(list);
    store.commit((s) => {
      const exist = new Set(s.items.filter((i) => i.kind === 'link').map((i) => i.url));
      for (const b of list.slice(0, 120)) {
        if (exist.has(b.url)) continue;
        s.items.push({ id: uid(), kind: 'link', title: b.title, url: b.url, cols: 1, rows: 1 });
      }
    });
    if (onLayoutChange) onLayoutChange();
    render();
  }

  async function enableFirefoxIcons(btn) {
    btn.textContent = '正在读取…';
    const res = await enableFirefoxCapture();
    if (res && res.ok) {
      btn.textContent = `已扫描 ${res.count || 0} 个标签页，写入 ${res.saved || 0} 个图标`;
      if (onIconsChanged) onIconsChanged();
    } else if (res && res.reason === 'denied') {
      btn.textContent = '未授权（不影响使用）';
    } else {
      btn.textContent = `读取失败（${(res && res.reason) || 'unknown'}），可再点一次`;
    }
    fillDiag();
  }

  async function fillDiag() {
    const el = document.getElementById('diag-icons');
    if (!el) return;
    const n = await countCachedIcons();
    const text = IS_FIREFOX
      ? `图标缓存 ${n} 个　|　tabs 权限：${(await hasTabsPermission()) ? '已授予' : '未授予'}`
      : `图标来源：_favicon（读浏览器本地缓存，无需授权）`;
    if (document.body.contains(el)) el.textContent = text;
  }

  /* ---------- 同步 ---------- */

  function setSyncStatus(text, kind) {
    const el = document.getElementById('sync-status');
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind || '';
  }

  function originForDraft(d) {
    if (!d) return '';
    if (d.provider === 'webdav') return d.webdav.url || '';
    if (d.provider === 'github') return 'https://api.github.com';
    return '';
  }

  function permHint(reason) {
    if (reason === 'no-api') return '当前环境不支持权限申请';
    if (reason === 'bad-url') return '服务器地址格式不对（要带 https://）';
    if (IS_FIREFOX) {
      return '可能被拒绝；Firefox 128 以下不支持按需授权域名，需要升级浏览器';
    }
    return '可能被拒绝，或地址不是 https';
  }

  /* 关键：requestOrigin 必须同步发起，中间不能等任何东西，否则用户手势失效，
     浏览器会静默返回 false——表现就是不弹窗、之后 fetch 报 Failed to fetch。 */
  function withPermission(act, btn) {
    const d = syncDraft;
    if (!d) return;
    const pending = requestOrigin(originForDraft(d));

    pending
      .then(async (res) => {
        if (!res.ok) {
          setSyncStatus(`未能授权 ${res.origin || ''}：${permHint(res.reason)}`, 'err');
          return;
        }
        syncGranted = true;
        await saveSettings(d);
        if (btn) btn.textContent = '已保存';
        await act();
      })
      .catch((e) => setSyncStatus('出错：' + ((e && e.message) || ''), 'err'));
  }

  function formatDiag(d) {
    if (!d) return '';
    const perm = d.granted ? '权限已授予' : '权限未授予';
    const net =
      d.reachable === false
        ? '域名不可达'
        : d.reachable === true
          ? `域名可达（HTTP ${d.status}，${d.ms}ms）`
          : '域名未检测';
    return `${perm}｜${net}`;
  }

  async function doTestSync() {
    setSyncStatus('正在连接…', '');
    const res = await testConnection();

    if (res.ok) {
      syncGranted = true;
      setSyncStatus(
        res.exists ? '连接正常，远端已有配置文件' : '连接正常，远端还没有配置文件',
        'ok'
      );
      return;
    }

    /* 失败时补一份诊断，直接区分「没权限」和「域名不通」 */
    const d = await diagnose();
    if (d) syncGranted = !!d.granted;
    setSyncStatus(`失败：${res.error}　—　${formatDiag(d)}`, 'err');
  }

  async function doSyncNow() {
    setSyncStatus('正在同步…', '');
    /* 手动触发用 now 模式：绕过 24 小时间隔，但仍然走「有变化才传」的判断 */
    const res = await syncNow(state, { mode: 'now', persist: () => store.flush() });
    if (res.status === 'pulled') {
      setSyncStatus('已拉取远端配置，正在刷新…', 'ok');
      setTimeout(() => location.reload(), 500);
      return;
    }
    if (res.status === 'conflict') {
      setSyncStatus('本地和远端都改过：往下滚，选择保留哪一份', 'warn');
      render();
      return;
    }
    if (res.status === 'error') {
      const d = await diagnose();
      setSyncStatus(`失败：${res.message || ''}　—　${formatDiag(d)}`, 'err');
      return;
    }

    if (res.status === 'pushed') {
      setSyncStatus(res.message || '已上传', 'ok');
      return;
    }

    const map = {
      noop: '无需同步，两边一致',
      skip: '还没到同步间隔',
      off: '同步已关闭'
    };
    setSyncStatus(map[res.status] || '完成', 'ok');
    syncMeta = await loadMeta();
  }

  async function doResolve(mode) {
    setSyncStatus('正在以' + (mode === 'pull' ? '远端' : '本地') + '为准…', '');
    const res = await syncNow(state, { mode, persist: () => store.flush() });
    if (res.status === 'error') {
      setSyncStatus('失败：' + (res.message || ''), 'err');
      return;
    }
    setSyncStatus('完成，正在刷新…', 'ok');
    setTimeout(() => location.reload(), 500);
  }

  /* ---------- 导入导出 ---------- */

  async function doExport() {
    const btn = document.getElementById('export-btn');
    if (btn) btn.textContent = '打包中…';
    try {
      const { text, filename, pack } = await buildPack(state);
      downloadPack(text, filename);
      if (btn) btn.textContent = `已导出（${pack.icons.length} 个图标）`;
    } catch (e) {
      if (btn) btn.textContent = '导出失败：' + ((e && e.message) || '');
    }
  }

  async function doImport(file) {
    if (!file) return;
    const text = await file.text();
    const res = await importPack(text);
    if (!res.ok) {
      window.alert('导入失败：' + res.error);
      return;
    }
    if (window.confirm(`已导入 ${res.counts.icons} 个图标${res.counts.hasWallpaper ? '和壁纸' : ''}，页面将刷新。`)) {
      location.reload();
    }
  }

  function toggleRow(items) {
    return h(
      'div',
      { class: 'row' },
      items.map(([label, key]) =>
        h('button', {
          class: 'btn',
          type: 'button',
          text: label,
          'aria-pressed': String(!!state.ui[key]),
          onclick: () => {
            store.commit((s) => {
              s.ui[key] = !s.ui[key];
            });
            if (onDisplayChange) onDisplayChange();
            render();
          }
        })
      )
    );
  }

  function linkRow(item) {
    return h('li', {}, [
      h('span', { class: 'l-name', text: item.title }),
      h('span', { class: 'l-url', text: hostOf(item.url) }),
      h('button', {
        class: 'mini',
        type: 'button',
        text: '移除',
        onclick: () => {
          store.commit((s) => {
            s.items = s.items.filter((x) => x.id !== item.id);
          });
          if (onLayoutChange) onLayoutChange();
          render();
        }
      })
    ]);
  }

  function render() {
    const perf = (() => {
      try {
        return JSON.parse(sessionStorage.getItem('zl.perf') || 'null');
      } catch {
        return null;
      }
    })();

    const version =
      ext && ext.runtime && ext.runtime.getManifest
        ? ext.runtime.getManifest().version
        : VERSION;

    const wallpaperRow = h(
      'div',
      { class: 'row' },
      PRESETS.map((p) =>
        h('button', {
          class: 'swatch',
          type: 'button',
          title: p.name,
          'aria-pressed': String(state.wallpaper.type === 'preset' && state.wallpaper.preset === p.id),
          onclick: () => {
            store.commit((s) => {
              s.wallpaper.type = 'preset';
              s.wallpaper.preset = p.id;
            });
            applyPreset(p.id);
            render();
          }
        })
      )
    );
    for (const [i, btn] of Array.from(wallpaperRow.children).entries()) {
      const p = PRESETS[i];
      btn.style.background = isDarkNow() ? p.dark : p.light;
    }

    const fileInput = h('input', {
      type: 'file',
      accept: 'image/*',
      style: 'display:none',
      onchange: async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          const blob = await compressImage(file);
          if (!blob) return;
          await saveWallpaperBlob(blob);
          await saveWallpaperShot(blob);
          bgEl.style.backgroundImage = `url("${URL.createObjectURL(blob)}")`;
          root.setAttribute('data-wall', 'image');
          document.dispatchEvent(new CustomEvent('zl:wallpaper'));
          store.commit((s) => {
            s.wallpaper.type = 'image';
            /* 换个 key，采样缓存才知道壁纸换了 */
            s.wallpaper.imageKey = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          });
          syncVeilUi();
        } catch {
          window.alert('这张图无法读取，换一张试试');
        }
      }
    });

    const veilLabel = h('span', {
      class: 'lbl',
      text: Math.round(currentVeil() * 100) + '%'
    });
    veilLabelEl = veilLabel;

    const dim = h('input', {
      type: 'range',
      min: '0',
      max: '0.8',
      step: '0.05',
      value: String(currentVeil()),
      oninput: (e) => {
        const v = Number(e.target.value);
        root.style.setProperty('--veil-a', String(v));
        veilLabel.textContent = Math.round(v * 100) + '%';
        store.commit((s) => {
          /* 三套强度各记各的：预设、照片+手动主题、照片+跟随系统，
             互相不覆盖，也不会因为切主题而串值 */
          if (s.wallpaper.type !== 'image') s.wallpaper.dim = v;
          else if (s.theme && (s.theme.mode === 'light' || s.theme.mode === 'dark')) s.wallpaper.imageDim = v;
          else s.wallpaper.adaptDim = v;
        });
      }
    });
    veilSlider = dim;

    const themeRow = h(
      'div',
      { class: 'row' },
      [
        { v: 'auto', t: '跟随系统' },
        { v: 'light', t: '浅色' },
        { v: 'dark', t: '深色' }
      ].map((opt) =>
        h('button', {
          class: 'btn',
          type: 'button',
          text: opt.t,
          'aria-pressed': String(state.theme.mode === opt.v),
          onclick: () => {
            store.commit((s) => {
              s.theme.mode = opt.v;
            });
            applyTheme(opt.v);
            render();
          }
        })
      )
    );

    const scaleLabel = h('span', {
      class: 'lbl',
      text: Math.round(state.ui.scale * 100) + '%'
    });

    const scaleSlider = h('input', {
      type: 'range',
      min: '0.85',
      max: '1.6',
      step: '0.05',
      value: String(state.ui.scale),
      oninput: (e) => {
        const v = Number(e.target.value);
        root.style.setProperty('--scale', String(v));
        scaleLabel.textContent = Math.round(v * 100) + '%';
        store.commit((s) => {
          s.ui.scale = v;
        });
      }
    });

    const engineRow = h(
      'div',
      { class: 'row' },
      ENGINES.map((eng) =>
        h('button', {
          class: 'btn',
          type: 'button',
          text: eng.name,
          'aria-pressed': String(state.engine === eng.id),
          onclick: () => {
            store.commit((s) => {
              s.engine = eng.id;
            });
            search.setEngine(eng.id);
            render();
          }
        })
      )
    );

    const nameInput = h('input', { type: 'text', placeholder: '名称' });
    const urlInput = h('input', { type: 'text', placeholder: '网址，如 example.com' });

    /* 去掉图标自带的白底板：读像素判断，默认开 */
    const stripBtn = h('button', {
      class: 'btn',
      type: 'button',
      text: '去掉图标白底',
      'aria-pressed': String(state.ui.stripIconBg !== false),
      onclick: (e) => {
        store.commit((s) => {
          s.ui.stripIconBg = s.ui.stripIconBg === false;
        });
        e.currentTarget.setAttribute('aria-pressed', String(state.ui.stripIconBg !== false));
        if (onLayoutChange) onLayoutChange();
      }
    });

    /* 上传的透明图标要不要去白边：只影响自定义图标，
       且只清掉与边缘连通的白色，logo 内部的白色不受影响 */
    const trimBtn = h('button', {
      class: 'btn',
      type: 'button',
      text: '透明图标去白边',
      'aria-pressed': String(!!state.ui.trimCustomWhite),
      onclick: (e) => {
        store.commit((s) => {
          s.ui.trimCustomWhite = !s.ui.trimCustomWhite;
        });
        e.currentTarget.setAttribute('aria-pressed', String(!!state.ui.trimCustomWhite));
        if (onLayoutChange) onLayoutChange();
      }
    });

    /* 已隐藏的图标：右键「隐藏」之后在这里恢复 */
    const hiddenItems = (state.items || []).filter((i) => i.hidden);
    const hiddenBlock = hiddenItems.length
      ? h('div', {}, [
          h('p', { class: 'hint-text', text: '已隐藏 ' + hiddenItems.length + ' 个，首页右键可以再隐藏别的' }),
          h(
            'ul',
            { class: 'list' },
            hiddenItems.map((it) =>
              h('li', {}, [
                h('span', { class: 'l-name', text: it.title || it.url || it.type || '组件' }),
                h('button', {
                  class: 'btn',
                  type: 'button',
                  text: '恢复',
                  onclick: () => {
                    store.commit((s) => {
                      const x = s.items.find((i) => i.id === it.id);
                      if (x) delete x.hidden;
                    });
                    if (onLayoutChange) onLayoutChange();
                    render();
                  }
                })
              ])
            )
          )
        ])
      : null;

    const iconSection = IS_FIREFOX
      ? h('div', {}, [
          h('div', { class: 'row' }, [
            h('button', {
              class: 'btn primary',
              type: 'button',
              text: '启用自动图标捕获',
              onclick: (e) => enableFirefoxIcons(e.currentTarget)
            }),
            h('button', {
              class: 'btn',
              type: 'button',
              text: '清空图标缓存',
              onclick: (e) => clearIcons(e.currentTarget)
            })
          ]),
          h('p', {
            class: 'hint-text',
            text:
              'Firefox 没有 Chromium 的 _favicon 接口。授权 tabs 权限后，扩展会读取已访问标签页的 favIconUrl（data: 内联数据，不发网络请求），按站点缓存 30 天。拒绝授权也不影响使用，图标退化为字母色块。'
          })
        ])
      : h('p', {
          class: 'hint-text',
          text:
            '当前使用 Chromium 的 _favicon 接口：直接读浏览器本地图标缓存，零网络、零存储，站点换图标会自动跟上，无需手动刷新。'
        });

    const links = linksOf(state);

    const d = syncDraft || {
      provider: 'off',
      webdav: { url: '', path: 'zenith/config.json', user: '', pass: '' },
      github: { repo: '', path: 'zenith/config.json', branch: 'main', token: '' },
      intervalMin: 1440,
      auto: true
    };

    const textField = (ph, value, oninput, type) =>
      h('input', {
        type: type || 'text',
        placeholder: ph,
        value: value || '',
        oninput: (e) => oninput(e.target.value)
      });

    const providerRow = h(
      'div',
      { class: 'row' },
      [
        ['off', '关闭'],
        ['webdav', 'WebDAV'],
        ['github', 'GitHub']
      ].map(([id, label]) =>
        h('button', {
          class: 'btn',
          type: 'button',
          text: label,
          'aria-pressed': String((d.provider || 'off') === id),
          onclick: () => {
            d.provider = id;
            render();
          }
        })
      )
    );

    const providerFields =
      d.provider === 'webdav'
        ? h('div', {}, [
            h('div', { class: 'field' }, [
              textField('服务器地址，如 https://dav.jianguoyun.com/dav/', d.webdav.url, (v) => {
                d.webdav.url = v;
              })
            ]),
            h('div', { class: 'field' }, [
              textField('用户名', d.webdav.user, (v) => {
                d.webdav.user = v;
              }),
              textField('应用密码', d.webdav.pass, (v) => {
                d.webdav.pass = v;
              }, 'password')
            ]),
            h('div', { class: 'field' }, [
              textField('文件路径', d.webdav.path, (v) => {
                d.webdav.path = v;
              })
            ])
          ])
        : d.provider === 'github'
          ? h('div', {}, [
              h('div', { class: 'field' }, [
                textField('仓库 owner/repo', d.github.repo, (v) => {
                  d.github.repo = v;
                })
              ]),
              h('div', { class: 'field' }, [
                textField('PAT（仅需 contents 读写）', d.github.token, (v) => {
                  d.github.token = v;
                }, 'password')
              ]),
              h('div', { class: 'field' }, [
                textField('分支', d.github.branch, (v) => {
                  d.github.branch = v;
                }),
                textField('文件路径', d.github.path, (v) => {
                  d.github.path = v;
                })
              ])
            ])
          : h('p', {
              class: 'hint-text',
              text: '关闭状态下扩展不会发出任何网络请求。选择后需要授权对应的域名。'
            });

    const intervalField = h('input', {
      type: 'number',
      min: String(MIN_INTERVAL),
      step: '15',
      value: String(d.intervalMin || 1440),
      oninput: (e) => {
        d.intervalMin = Math.max(MIN_INTERVAL, Number(e.target.value) || MIN_INTERVAL);
      }
    });

    const statusText =
      syncMeta && syncMeta.lastAt
        ? `上次：${syncMeta.lastResult || '—'}　|　${new Date(syncMeta.lastAt).toLocaleString()}` +
          (d.provider === 'off' ? '' : syncGranted ? '　|　域名已授权' : '　|　域名未授权')
        : '还没同步过';

    const statusKind = syncMeta && syncMeta.failed ? 'err' : '';

    const syncSection = h('section', { class: 'sec' }, [
      h('h3', { text: '同步' }),
      providerRow,
      providerFields,
      d.provider === 'off'
        ? null
        : h('div', { class: 'row' }, [
            h('button', {
              class: 'btn primary',
              type: 'button',
              text: '保存并授权',
              onclick: (e) =>
                withPermission(async () => {
                  setSyncStatus('已保存，可以点「测试连接」验证', 'ok');
                }, e.currentTarget)
            }),
            h('button', {
              class: 'btn',
              type: 'button',
              text: '测试连接',
              onclick: () => withPermission(doTestSync)
            }),
            h('button', {
              class: 'btn',
              type: 'button',
              text: '立即同步',
              onclick: () => withPermission(doSyncNow)
            })
          ]),
      h('div', { class: 'diag', id: 'sync-status', 'data-kind': statusKind, text: statusText }),
      d.provider === 'off'
        ? null
        : h('div', { class: 'row' }, [
            h('span', { class: 'lbl', text: '间隔（分钟）' }),
            intervalField,
            h('span', { class: 'hint-text', text: `最小 ${MIN_INTERVAL}，默认 1440（24 小时）` })
          ]),
      d.provider === 'off'
        ? null
        : h('div', { class: 'row' }, [
            h('button', {
              class: 'btn',
              type: 'button',
              text: '用远端覆盖本地',
              onclick: () => withPermission(() => doResolve('pull'))
            }),
            h('button', {
              class: 'btn',
              type: 'button',
              text: '用本地覆盖远端',
              onclick: () => withPermission(() => doResolve('push'))
            })
          ]),
      h('p', {
        class: 'hint-text',
        text:
          '同步只传配置（布局、图标地址、组件数据），不传任何图片。页面代码里没有网络请求，同步全部经由后台发出，且只发往你填写的那一个地址。'
      })
    ]);

    const importInput = h('input', {
      type: 'file',
      accept: 'application/json,.json',
      style: 'display:none',
      onchange: async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        await doImport(file);
      }
    });

    const dataSection = h('section', { class: 'sec' }, [
      h('h3', { text: '数据' }),
      h('div', { class: 'row' }, [
        h('button', {
          class: 'btn',
          type: 'button',
          text: '导出配置',
          id: 'export-btn',
          onclick: doExport
        }),
        h('button', {
          class: 'btn',
          type: 'button',
          text: '导入配置',
          onclick: () => importInput.click()
        }),
        importInput
      ]),
      h('p', {
        class: 'hint-text',
        text: '导出为单个 JSON，包含布局、壁纸图片和图标缓存，可直接换机器恢复。'
      })
    ]);

    panel.textContent = '';
    panel.append(
      h('div', { class: 'panel-card' }, [
        h('div', { class: 'panel-head' }, [
          h('h2', {}, ['设置', h('span', { class: 'ver', text: 'v' + version })]),
          h('button', { class: 'panel-close', type: 'button', text: '关闭', onclick: closePanel })
        ]),
        h('section', { class: 'sec' }, [
          h('h3', { text: '壁纸' }),
          wallpaperRow,
          h('div', { class: 'row' }, [
            h('button', {
              class: 'btn',
              type: 'button',
              text: '上传图片',
              onclick: () => fileInput.click()
            }),
            fileInput,
            h('span', { class: 'hint-text', text: '导入时自动压到 2560px 宽、WebP，存放在本地' })
          ]),
          h('div', { class: 'row' }, [h('span', { class: 'lbl', text: '遮罩' }), dim, veilLabel]),
          h('p', {
            class: 'hint-text',
            text:
              '深色主题下遮罩是压暗，浅色主题下是提亮。跟随系统且自动配色时默认 15%（配色已经对上，不需要重压）；手动指定主题时默认 35%。两个值分开记，互不影响。'
          })
        ]),
        h('section', { class: 'sec' }, [h('h3', { text: '主题' }), themeRow]),
        h('section', { class: 'sec' }, [
          h('h3', { text: '字号' }),
          h('div', { class: 'row' }, [scaleLabel, scaleSlider])
        ]),
        h('section', { class: 'sec' }, [
          h('h3', { text: '显示' }),
          toggleRow([
            ['搜索栏', 'search'],
            ['添加组件按钮', 'showAdd'],
            ['极简模式', 'zen']
          ]),
          h('p', {
            class: 'hint-text',
            text: '极简模式只留时间。也可以直接点首页的时间进入或退出。'
          })
        ]),
        h('section', { class: 'sec' }, [h('h3', { text: '搜索引擎' }), engineRow]),
        h('section', { class: 'sec' }, [
          h('h3', { text: '站点' }),
          h('div', { class: 'field' }, [nameInput, urlInput]),
          h('div', { class: 'row' }, [
            h('button', {
              class: 'btn primary',
              type: 'button',
              text: '添加',
              onclick: () => {
                const url = normalizeUrl(urlInput.value);
                if (!url) return;
                store.commit((s) => {
                  s.items.push({
                    id: uid(),
                    kind: 'link',
                    title: nameInput.value.trim() || hostOf(url),
                    url,
                    cols: 1,
                    rows: 1
                  });
                });
                nameInput.value = '';
                urlInput.value = '';
                if (onLayoutChange) onLayoutChange();
                render();
              }
            }),
            h('button', {
              class: 'btn',
              type: 'button',
              text: '从书签导入',
              onclick: importBookmarks
            })
          ]),
          h('ul', { class: 'list' }, links.map(linkRow))
        ]),
        syncSection,
        dataSection,
        h('section', { class: 'sec' }, [
          h('h3', { text: '图标' }),
          iconSection,
          h('div', { class: 'row' }, [stripBtn, trimBtn]),
          h('p', {
            class: 'hint-text',
            text:
              '右键首页图标可以上传自定义图标（PNG/JPEG/WebP/GIF/SVG/ICO），WebDAV 同步和手动导出都会带上它。'
          }),
          hiddenBlock
        ]),
        h('section', { class: 'sec' }, [
          h('h3', { text: '诊断' }),
          h('div', { class: 'diag', id: 'diag-icons' }),
          h('div', {
            class: 'diag',
            text: perf
              ? `首帧渲染 ${perf.rendered} ms（自脚本开始计时）　|　版本 ${version}`
              : '本次会话尚未记录性能数据，重新打开新标签页即可看到'
          }),
          h('p', {
            class: 'hint-text',
            text:
              '本页不包含任何网络请求代码——构建时会扫描整个源码树，除同步内核外，任何文件出现网络调用都直接构建失败。同步关闭时，扩展运行时零请求；不含任何统计或上报代码。'
          })
        ])
      ])
    );

    fillDiag();
  }

  async function clearIcons(btn) {
    await idbClear(STORE_ICONS);
    clearIconUrlCache();
    document.querySelectorAll('.icon.has-img').forEach((n) => n.classList.remove('has-img'));
    document.querySelectorAll('.icon img').forEach((n) => {
      n.removeAttribute('src');
      n.style.opacity = '0';
    });
    btn.textContent = '已清空';
  }

  render();
  panel.hidden = true;
}
