/* 设置面板（按需加载）：壁纸 / 主题 / 语言 / 字号 / 显示 / 搜索 / 站点 /
   组件配置 / 同步 / 数据 / 快照 / 图标 / 诊断。
   全部本地操作；涉及权限的只有「导入书签」和 Firefox 的「启用图标捕获」。
   所有文案走 t()，字典在 strings.js；h() 只压平一层，嵌套数组一律用 ... 展开。 */
import { IS_FIREFOX, ext, normalizeUrl, hostOf } from './util.js';
import { uid, linksOf, veilOf, themeAt } from './store.js';
import { ENGINES } from './search.js';
import {
  saveWallpaperBlob, saveWallpaperShot, clearWallpaperShot,
  enableFirefoxCapture, hasTabsPermission, countCachedIcons
} from './favicon.js';
import {
  compressImage, addWallpaperSlides, activateSlide, removeSlideFiles,
  clearRotationCache, MAX_SLIDES
} from './wallpapers.js';
import { clearIconUrlCache } from './iconview.js';
import { idbClear, STORE_ICONS } from './idb.js';
import { flattenBookmarks } from './bookmarks.js';
import {
  loadSettings, saveSettings, loadMeta, syncNow, testConnection,
  diagnose, requestOrigin, hasOrigin, MIN_INTERVAL, previewSync
} from './sync.js';
import { formatDiff } from './diff.js';
import { buildPack, downloadPack, importPack } from './pack.js';
import { WIDGETS } from './registry.js';
import { renderConfigSection } from './config.js';
import { listSnapshots, takeSnapshot, restoreSnapshot, deleteSnapshot, SNAP_FIELDS, SNAP_LIMIT } from './snapshots.js';
import { storageUsage, cleanupOrphans } from './storage.js';
import { t } from './i18n.js';
import EXTRA_STRINGS from './strings-extra.js';
import { VERSION } from './version.js';

const STATE_KEY = 'zl.state';

const PRESETS = [
  { id: 'ink', key: 'wall.preset.ink', light: '#f4f3ef', dark: '#16181c' },
  { id: 'sage', key: 'wall.preset.sage', light: '#edf2ea', dark: '#16211d' },
  { id: 'dusk', key: 'wall.preset.dusk', light: '#f2eff7', dark: '#191625' },
  {
    id: 'aurora', key: 'wall.preset.aurora',
    light: 'linear-gradient(158deg,#eef2ff,#f6eef8 52%,#e9f6f0)',
    dark: 'linear-gradient(158deg,#0f1526,#1a1226 52%,#0c1e1b)'
  },
  {
    id: 'dawn', key: 'wall.preset.dawn',
    light: 'linear-gradient(148deg,#fff4e8,#fce9e9 58%,#f3e9ff)',
    dark: 'linear-gradient(148deg,#231a12,#291418 58%,#1c1424)'
  },
  {
    id: 'moss', key: 'wall.preset.moss',
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
  const adapt = root.getAttribute('data-adapt');
  if (adapt === 'dark') return true;
  if (adapt === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

export function mountSettings({ store, search, onBookmarks, onIconsChanged, onDisplayChange, onLayoutChange, onLanguageChange, onBeforeOverwrite, onWallpaperChange }) {
  /* 首屏字典只带核心文案，面板的长文案在这里补齐（本模块本来就是懒加载的） */
  if (globalThis.ZL_I18N && globalThis.ZL_I18N.extend) globalThis.ZL_I18N.extend(EXTRA_STRINGS);
  const { state } = store;
  const panel = document.getElementById('panel');
  const bgEl = document.getElementById('bg');
  const root = document.documentElement;

  let syncDraft = null;
  let syncMeta = null;
  let syncGranted = false;
  let snapList = [];
  let quota = null;
  let extraStatus = '';

  let veilSlider = null;
  let veilLabelEl = null;

  function currentVeil() {
    return veilOf(state.wallpaper, themeAt(state.theme) || state.theme.mode);
  }

  function syncVeilUi() {
    const v = currentVeil();
    root.style.setProperty('--veil-a', String(v));
    if (veilSlider) veilSlider.value = String(v);
    if (veilLabelEl) veilLabelEl.textContent = Math.round(v * 100) + '%';
  }

  function applyPreset(id) {
    root.setAttribute('data-wallpaper', id);
    root.setAttribute('data-wall', 'preset');
    bgEl.style.backgroundImage = '';
    root.style.backgroundImage = '';
    clearWallpaperShot();
    clearRotationCache();
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
    snapList = await listSnapshots();
    quota = await storageUsage();
    extraStatus = '';
    panel.hidden = false;
    render();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) closePanel();
  });
  panel.addEventListener('click', (e) => {
    if (e.target === panel) closePanel();
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
    btn.textContent = t('icon.reading');
    const res = await enableFirefoxCapture();
    if (res && res.ok) {
      btn.textContent = t('icon.scanned', res.count || 0, res.saved || 0);
      if (onIconsChanged) onIconsChanged();
    } else if (res && res.reason === 'denied') {
      btn.textContent = t('icon.denied');
    } else {
      btn.textContent = t('icon.readFail', (res && res.reason) || 'unknown');
    }
    fillDiag();
  }

  async function fillDiag() {
    const el = document.getElementById('diag-icons');
    if (el) {
      const n = await countCachedIcons();
      const text = IS_FIREFOX
        ? t('icon.cacheCount', n, (await hasTabsPermission()) ? t('icon.granted') : t('icon.notGranted'))
        : t('icon.hintChromium');
      if (document.body.contains(el)) el.textContent = text;
    }
    const q = document.getElementById('diag-quota');
    if (q && quota) {
      q.textContent = t('storage.usage',
        (quota.usage / 1048576).toFixed(1), (quota.quota / 1048576).toFixed(0));
    }
  }

  /* ---------- 同步 ---------- */

  function setSyncStatus(text, kind) {
    extraStatus = text || '';
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
    if (reason === 'no-api') return t('sync.permNoApi');
    if (reason === 'bad-url') return t('sync.permBadUrl');
    if (IS_FIREFOX) return t('sync.permFirefox');
    return t('sync.permGeneric');
  }

  function withPermission(act, btn) {
    const d = syncDraft;
    if (!d) return;
    /* 必须同步发起，中间不能 await，否则用户手势失效 */
    const pending = requestOrigin(originForDraft(d));
    pending
      .then(async (res) => {
        if (!res.ok) {
          setSyncStatus(t('sync.permFailed', res.origin || '', permHint(res.reason)), 'err');
          return;
        }
        syncGranted = true;
        await saveSettings(d);
        if (btn) btn.textContent = t('sync.saved');
        await act();
      })
      .catch((e) => setSyncStatus(t('sync.errorPrefix', (e && e.message) || ''), 'err'));
  }

  function formatDiag(d) {
    if (!d) return '';
    const perm = d.granted ? t('sync.diagGranted') : t('sync.diagDenied');
    const net =
      d.reachable === false
        ? t('sync.diagUnreachable')
        : d.reachable === true
          ? t('sync.diagReachable', d.status, d.ms)
          : t('sync.diagUnknown');
    return `${perm}｜${net}`;
  }

  async function doTestSync() {
    setSyncStatus(t('sync.connecting'), '');
    const res = await testConnection();
    if (res.ok) {
      syncGranted = true;
      setSyncStatus(res.exists ? t('sync.connectedExists') : t('sync.connectedEmpty'), 'ok');
      return;
    }
    const d = await diagnose();
    if (d) syncGranted = !!d.granted;
    setSyncStatus(t('sync.errorPrefix', res.error) + '　—　' + formatDiag(d), 'err');
  }

  async function doPreview() {
    setSyncStatus(t('sync.connecting'), '');
    const res = await previewSync(state);
    if (!res.ok) {
      setSyncStatus(t('sync.errorPrefix', res.error || res.reason), 'err');
      return;
    }
    if (res.empty) {
      setSyncStatus(t('sync.connectedEmpty'), 'ok');
      return;
    }
    setSyncStatus(t('sync.changes', formatDiff(res.diff, t)), 'ok');
  }

  async function doSyncNow() {
    setSyncStatus(t('sync.syncing'), '');
    const res = await syncNow(state, {
      mode: 'now',
      persist: () => store.flush(),
      onBeforeOverwrite
    });
    if (res.status === 'pulled') {
      setSyncStatus(t('sync.pulledReload'), 'ok');
      setTimeout(() => location.reload(), 500);
      return;
    }
    if (res.status === 'conflict') {
      setSyncStatus(t('sync.conflictHint'), 'warn');
      syncMeta = await loadMeta();
      render();
      return;
    }
    if (res.status === 'error') {
      const d = await diagnose();
      setSyncStatus(t('sync.errorPrefix', res.message || '') + '　—　' + formatDiag(d), 'err');
      return;
    }
    if (res.status === 'pushed') {
      setSyncStatus(res.message || t('sync.done'), 'ok');
      syncMeta = await loadMeta();
      return;
    }
    const map = {
      noop: t('sync.noop'), skip: t('sync.skip'), off: t('sync.offStatus')
    };
    setSyncStatus(map[res.status] || t('sync.done'), 'ok');
    syncMeta = await loadMeta();
  }

  async function doResolve(mode) {
    setSyncStatus(t('sync.resolving', t(mode === 'pull' ? 'sync.remote' : 'sync.local')), '');
    const res = await syncNow(state, { mode, persist: () => store.flush(), onBeforeOverwrite });
    if (res.status === 'error') {
      setSyncStatus(t('sync.errorPrefix', res.message || ''), 'err');
      return;
    }
    setSyncStatus(t('sync.finishedReload'), 'ok');
    setTimeout(() => location.reload(), 500);
  }

  /* ---------- 导入导出 ---------- */

  async function doExport() {
    const btn = document.getElementById('export-btn');
    if (btn) btn.textContent = t('data.exporting');
    try {
      const { text, filename, pack } = await buildPack(state);
      downloadPack(text, filename);
      if (btn) btn.textContent = t('data.exported', pack.icons.length);
    } catch (e) {
      if (btn) btn.textContent = t('data.exportFail', (e && e.message) || '');
    }
  }

  async function doImport(file) {
    if (!file) return;
    const text = await file.text();
    const res = await importPack(text);
    if (!res.ok) {
      window.alert(t('data.importFail', res.error));
      return;
    }
    if (window.confirm(t('data.importConfirm', res.counts.icons,
      res.counts.hasWallpaper ? t('data.andWallpaper') : ''))) {
      location.reload();
    }
  }

  /* ---------- 快照 ---------- */

  async function refreshSnapshots() {
    snapList = await listSnapshots();
    render();
  }

  async function doTakeSnapshot() {
    await takeSnapshot(state, 'manual');
    await refreshSnapshots();
  }

  async function doRestoreSnapshot(ts) {
    if (!window.confirm(t('snap.confirm'))) return;
    const snap = await restoreSnapshot(ts, state);
    if (!snap) return;
    /* 直接改内存状态再 flush：这样 reload 时 pagehide 的 flush 写的也是快照，
       不会把刚恢复的内容又覆盖回旧状态。 */
    store.commit((s) => {
      for (const k of Object.keys(s)) if (!(k in snap)) delete s[k];
      for (const k of SNAP_FIELDS) if (k in snap) s[k] = snap[k];
    });
    store.flush();
    setSyncStatus(t('snap.restored'), 'ok');
    setTimeout(() => location.reload(), 400);
  }

  async function doDeleteSnapshot(ts) {
    await deleteSnapshot(ts);
    await refreshSnapshots();
  }

  /* ---------- 通用小组件 ---------- */

  function toggleRow(items) {
    return h('div', { class: 'row wrap' },
      items.map(([label, key]) =>
        h('button', {
          class: 'btn', type: 'button', text: label,
          'aria-pressed': String(!!state.ui[key]),
          onclick: () => {
            store.commit((s) => { s.ui[key] = !s.ui[key]; });
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
        class: 'mini', type: 'button', text: t('site.remove'),
        onclick: () => {
          store.commit((s) => { s.items = s.items.filter((x) => x.id !== item.id); });
          if (onLayoutChange) onLayoutChange();
          render();
        }
      })
    ]);
  }

  /* ---------- 主渲染 ---------- */

  function render() {
    const perf = (() => {
      try { return JSON.parse(sessionStorage.getItem('zl.perf') || 'null'); }
      catch { return null; }
    })();
    const version = ext && ext.runtime && ext.runtime.getManifest
      ? ext.runtime.getManifest().version
      : VERSION;

    /* 壁纸 */
    const wallpaperRow = h('div', { class: 'row wrap' },
      PRESETS.map((p) =>
        h('button', {
          class: 'swatch', type: 'button', title: t(p.key),
          'aria-pressed': String(state.wallpaper.type === 'preset' && state.wallpaper.preset === p.id),
          onclick: () => {
            store.commit((s) => { s.wallpaper.type = 'preset'; s.wallpaper.preset = p.id; });
            applyPreset(p.id);
            render();
          }
        })
      )
    );
    for (const [i, btn] of Array.from(wallpaperRow.children).entries()) {
      btn.style.background = isDarkNow() ? PRESETS[i].dark : PRESETS[i].light;
    }

    const singleInput = h('input', {
      type: 'file', accept: 'image/*', style: 'display:none',
      onchange: async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
          const blob = await compressImage(file);
          if (!blob) return;
          await saveWallpaperBlob(blob);
          await saveWallpaperShot(blob);
          clearRotationCache();
          bgEl.style.backgroundImage = `url("${URL.createObjectURL(blob)}")`;
          root.setAttribute('data-wall', 'image');
          store.commit((s) => {
            s.wallpaper.type = 'image';
            s.wallpaper.rotate = false;
            s.wallpaper.imageKey = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          });
          if (onWallpaperChange) onWallpaperChange();
          syncVeilUi();
          render();
        } catch {
          window.alert(t('wall.badImage'));
        }
      }
    });

    const multiInput = h('input', {
      type: 'file', accept: 'image/*', multiple: true, style: 'display:none',
      onchange: async (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        if (!files.length) return;
        const added = await addWallpaperSlides(files.slice(0, MAX_SLIDES));
        if (!added.length) return;
        await activateSlide(added[0].blob, added[0].key, 0);
        bgEl.style.backgroundImage = `url("${URL.createObjectURL(added[0].blob)}")`;
        store.commit((s) => {
          s.wallpaper.type = 'image';
          s.wallpaper.imageKey = added[0].key;
          s.wallpaper.slides = added.map((x) => ({ key: x.key }));
          s.wallpaper.rotate = added.length > 1;
        });
        if (onWallpaperChange) onWallpaperChange();
        syncVeilUi();
        render();
      }
    });

    const slides = state.wallpaper.slides || [];
    const slideList = slides.length
      ? h('ul', { class: 'list' }, slides.map((s, i) =>
          h('li', {}, [
            h('span', { class: 'l-name', text: '#' + (i + 1) + '  ' + s.key.slice(-6) }),
            h('button', {
              class: 'mini', type: 'button', text: t('snap.delete'),
              onclick: async () => {
                const key = s.key;
                store.commit((st) => {
                  st.wallpaper.slides = (st.wallpaper.slides || []).filter((x) => x.key !== key);
                  if (!st.wallpaper.slides.length) st.wallpaper.rotate = false;
                });
                removeSlideFiles([key]);
                render();
              }
            })
          ])
        ))
      : null;

    const veilLabel = h('span', { class: 'lbl', text: Math.round(currentVeil() * 100) + '%' });
    veilLabelEl = veilLabel;
    const dim = h('input', {
      type: 'range', min: '0', max: '0.8', step: '0.05', value: String(currentVeil()),
      oninput: (e) => {
        const v = Number(e.target.value);
        root.style.setProperty('--veil-a', String(v));
        veilLabel.textContent = Math.round(v * 100) + '%';
        store.commit((s) => {
          if (s.wallpaper.type !== 'image') s.wallpaper.dim = v;
          else if (themeAt(s.theme)) s.wallpaper.imageDim = v;
          else s.wallpaper.adaptDim = v;
        });
      }
    });
    veilSlider = dim;

    /* 主题 */
    const themeRow = h('div', { class: 'row wrap' },
      [
        { v: 'auto', k: 'theme.auto' },
        { v: 'light', k: 'theme.light' },
        { v: 'dark', k: 'theme.dark' }
      ].map((opt) =>
        h('button', {
          class: 'btn', type: 'button', text: t(opt.k),
          'aria-pressed': String(state.theme.mode === opt.v),
          onclick: () => {
            store.commit((s) => { s.theme.mode = opt.v; });
            if (onDisplayChange) onDisplayChange();
            render();
          }
        })
      )
    );

    const sched = state.theme.schedule || { enabled: false, dayStart: 7, nightStart: 19 };
    const dayIn = h('input', { type: 'number', min: '0', max: '23', value: String(sched.dayStart) });
    const nightIn = h('input', { type: 'number', min: '0', max: '23', value: String(sched.nightStart) });
    const schedBtn = h('button', {
      class: 'btn', type: 'button', text: t('theme.schedule'),
      'aria-pressed': String(sched.enabled),
      onclick: () => {
        store.commit((s) => {
          s.theme.schedule = {
            enabled: !s.theme.schedule.enabled,
            dayStart: Math.min(23, Math.max(0, Math.round(Number(dayIn.value)) || 0)),
            nightStart: Math.min(23, Math.max(0, Math.round(Number(nightIn.value)) || 0))
          };
        });
        if (onDisplayChange) onDisplayChange();
        render();
      }
    });

    /* 语言 */
    const langRow = h('div', { class: 'row wrap' },
      [
        { v: 'auto', k: 'lang.auto' },
        { v: 'zh_CN', k: 'lang.zh' },
        { v: 'en', k: 'lang.en' }
      ].map((opt) =>
        h('button', {
          class: 'btn', type: 'button', text: t(opt.k),
          'aria-pressed': String(state.ui.lang === opt.v),
          onclick: () => {
            store.commit((s) => { s.ui.lang = opt.v; });
            if (onLanguageChange) onLanguageChange();
            else render();
          }
        })
      )
    );

    /* 字号 */
    const scaleLabel = h('span', { class: 'lbl', text: Math.round(state.ui.scale * 100) + '%' });
    const scaleSlider = h('input', {
      type: 'range', min: '0.85', max: '1.6', step: '0.05', value: String(state.ui.scale),
      oninput: (e) => {
        const v = Number(e.target.value);
        root.style.setProperty('--scale', String(v));
        scaleLabel.textContent = Math.round(v * 100) + '%';
        store.commit((s) => { s.ui.scale = v; });
      }
    });

    const engineRow = h('div', { class: 'row wrap' },
      ENGINES.map((eng) =>
        h('button', {
          class: 'btn', type: 'button', text: eng.name,
          'aria-pressed': String(state.engine === eng.id),
          onclick: () => {
            store.commit((s) => { s.engine = eng.id; });
            search.setEngine(eng.id);
            render();
          }
        })
      )
    );

    const nameInput = h('input', { type: 'text', placeholder: t('site.name') });
    const urlInput = h('input', { type: 'text', placeholder: t('site.url') });

    const stripBtn = h('button', {
      class: 'btn', type: 'button', text: t('icon.strip'),
      'aria-pressed': String(state.ui.stripIconBg !== false),
      onclick: (e) => {
        store.commit((s) => { s.ui.stripIconBg = s.ui.stripIconBg === false; });
        e.currentTarget.setAttribute('aria-pressed', String(state.ui.stripIconBg !== false));
        if (onLayoutChange) onLayoutChange();
      }
    });
    const trimBtn = h('button', {
      class: 'btn', type: 'button', text: t('icon.trim'),
      'aria-pressed': String(!!state.ui.trimCustomWhite),
      onclick: (e) => {
        store.commit((s) => { s.ui.trimCustomWhite = !s.ui.trimCustomWhite; });
        e.currentTarget.setAttribute('aria-pressed', String(!!state.ui.trimCustomWhite));
        if (onLayoutChange) onLayoutChange();
      }
    });

    const hiddenItems = (state.items || []).filter((i) => i.hidden);
    const hiddenBlock = hiddenItems.length
      ? h('div', {}, [
          h('p', { class: 'hint-text', text: t('icon.hiddenHint', hiddenItems.length) }),
          h('ul', { class: 'list' }, hiddenItems.map((it) =>
            h('li', {}, [
              h('span', { class: 'l-name', text: it.title || it.url || it.type || t('icon.widget') }),
              h('button', {
                class: 'btn', type: 'button', text: t('icon.restore'),
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
          ))
        ])
      : null;

    const iconSection = IS_FIREFOX
      ? h('div', {}, [
          h('div', { class: 'row wrap' }, [
            h('button', {
              class: 'btn primary', type: 'button', text: t('icon.enableCapture'),
              onclick: (e) => enableFirefoxIcons(e.currentTarget)
            }),
            h('button', {
              class: 'btn', type: 'button', text: t('icon.clearCache'),
              onclick: (e) => clearIcons(e.currentTarget)
            })
          ]),
          h('p', { class: 'hint-text', text: t('icon.hintFirefox') })
        ])
      : h('p', { class: 'hint-text', text: t('icon.hintChromium') });

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
        type: type || 'text', placeholder: ph, value: value || '',
        oninput: (e) => oninput(e.target.value)
      });

    const providerRow = h('div', { class: 'row wrap' },
      [
        ['off', t('sync.off')], ['webdav', 'WebDAV'], ['github', 'GitHub']
      ].map(([id, label]) =>
        h('button', {
          class: 'btn', type: 'button', text: label,
          'aria-pressed': String((d.provider || 'off') === id),
          onclick: () => { d.provider = id; render(); }
        })
      )
    );

    const providerFields =
      d.provider === 'webdav'
        ? h('div', {}, [
            h('div', { class: 'field' }, [
              textField(t('sync.field.webdavUrl'), d.webdav.url, (v) => { d.webdav.url = v; })
            ]),
            h('div', { class: 'field' }, [
              textField(t('sync.field.user'), d.webdav.user, (v) => { d.webdav.user = v; }),
              textField(t('sync.field.pass'), d.webdav.pass, (v) => { d.webdav.pass = v; }, 'password')
            ]),
            h('div', { class: 'field' }, [
              textField(t('sync.field.path'), d.webdav.path, (v) => { d.webdav.path = v; })
            ])
          ])
        : d.provider === 'github'
          ? h('div', {}, [
              h('div', { class: 'field' }, [
                textField(t('sync.field.repo'), d.github.repo, (v) => { d.github.repo = v; })
              ]),
              h('div', { class: 'field' }, [
                textField(t('sync.field.token'), d.github.token, (v) => { d.github.token = v; }, 'password')
              ]),
              h('div', { class: 'field' }, [
                textField(t('sync.field.branch'), d.github.branch, (v) => { d.github.branch = v; }),
                textField(t('sync.field.path'), d.github.path, (v) => { d.github.path = v; })
              ])
            ])
          : h('p', { class: 'hint-text', text: t('sync.offHint') });

    const intervalField = h('input', {
      type: 'number', min: String(MIN_INTERVAL), step: '15',
      value: String(d.intervalMin || 1440),
      oninput: (e) => {
        d.intervalMin = Math.max(MIN_INTERVAL, Number(e.target.value) || MIN_INTERVAL);
      }
    });

    const statusText =
      syncMeta && syncMeta.lastAt
        ? t('sync.lastAt', syncMeta.lastResult || '—',
            new Date(syncMeta.lastAt).toLocaleString(),
            d.provider === 'off' ? '' : syncGranted ? t('sync.domainGranted') : t('sync.domainNotGranted'))
        : t('sync.never');
    const statusKind = syncMeta && syncMeta.failed ? 'err' : '';

    const widgetSyncRow = d.provider === 'off' ? null
      : h('div', { class: 'row wrap' }, [
          h('span', { class: 'lbl', text: t('sync.widgetData') }),
          ...WIDGETS.map((w) => {
            const on = !(state.syncByType && state.syncByType[w.type] === false);
            return h('button', {
              class: 'btn', type: 'button', text: t(w.nameKey),
              title: t(on ? 'sync.widgetOn' : 'sync.widgetOff'),
              'aria-pressed': String(on),
              onclick: () => {
                store.commit((s) => {
                  s.syncByType = s.syncByType || {};
                  s.syncByType[w.type] = !on;
                });
                render();
              }
            });
          })
        ]);

    const changes = syncMeta && syncMeta.lastChanges && !syncMeta.lastChanges.empty
      ? h('p', { class: 'hint-text', text: t('sync.changes', formatDiff(syncMeta.lastChanges, t)) })
      : null;

    const syncSection = h('section', { class: 'sec' }, [
      h('h3', { text: t('sec.sync') }),
      providerRow,
      providerFields,
      d.provider === 'off' ? null : h('div', { class: 'row wrap' }, [
        h('button', {
          class: 'btn primary', type: 'button', text: t('sync.save'),
          onclick: (e) => withPermission(async () => {
            setSyncStatus(t('sync.savedHint'), 'ok');
          }, e.currentTarget)
        }),
        h('button', { class: 'btn', type: 'button', text: t('sync.test'), onclick: () => withPermission(doTestSync) }),
        h('button', { class: 'btn', type: 'button', text: t('sync.now'), onclick: () => withPermission(doSyncNow) }),
        h('button', { class: 'btn', type: 'button', text: t('sync.preview'), onclick: () => withPermission(doPreview) })
      ]),
      h('div', { class: 'diag', id: 'sync-status', 'data-kind': statusKind, text: extraStatus || statusText }),
      changes,
      h('p', { class: 'hint-text', text: t('sync.previewHint') }),
      widgetSyncRow,
      d.provider === 'off' ? null : h('p', { class: 'hint-text', text: t('sync.widgetHint') }),
      d.provider === 'off' ? null : h('div', { class: 'row wrap' }, [
        h('span', { class: 'lbl', text: t('sync.interval') }),
        intervalField,
        h('span', { class: 'hint-text', text: t('sync.intervalHint', MIN_INTERVAL) })
      ]),
      d.provider === 'off' ? null : h('div', { class: 'row wrap' }, [
        h('button', { class: 'btn', type: 'button', text: t('sync.pull'), onclick: () => withPermission(() => doResolve('pull')) }),
        h('button', { class: 'btn', type: 'button', text: t('sync.push'), onclick: () => withPermission(() => doResolve('push')) })
      ]),
      h('p', { class: 'hint-text', text: t('sync.hint') })
    ]);

    const importInput = h('input', {
      type: 'file', accept: 'application/json,.json', style: 'display:none',
      onchange: async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        await doImport(file);
      }
    });

    const dataSection = h('section', { class: 'sec' }, [
      h('h3', { text: t('sec.data') }),
      h('div', { class: 'row wrap' }, [
        h('button', { class: 'btn', type: 'button', text: t('data.export'), id: 'export-btn', onclick: doExport }),
        h('button', { class: 'btn', type: 'button', text: t('data.import'), onclick: () => importInput.click() }),
        importInput
      ]),
      h('p', { class: 'hint-text', text: t('data.hint') })
    ]);

    const snapshotRows = snapList.length
      ? snapList.map((s) =>
          h('li', {}, [
            h('span', { class: 'l-name', text: t('snap.item', new Date(s.ts).toLocaleString(), s.count) }),
            h('span', { class: 'l-url', text: t(s.reason === 'sync' ? 'snap.beforeSync' : s.reason === 'manual' ? 'snap.backupNow' : 'snap.auto') }),
            h('button', {
              class: 'mini', type: 'button', text: t('snap.restore'),
              onclick: () => doRestoreSnapshot(s.ts)
            }),
            h('button', {
              class: 'mini', type: 'button', text: t('snap.delete'),
              onclick: () => doDeleteSnapshot(s.ts)
            })
          ])
        )
      : [h('p', { class: 'hint-text', text: t('snap.empty') })];
    const snapshotSection = h('section', { class: 'sec' }, [
      h('h3', { text: t('sec.snapshots') }),
      h('div', { class: 'row wrap' }, [
        h('button', { class: 'btn', type: 'button', text: t('snap.take'), onclick: doTakeSnapshot })
      ]),
      h('ul', { class: 'list' }, snapshotRows),
      h('p', { class: 'hint-text', text: t('snap.hint', SNAP_LIMIT) })
    ]);

    const configSection = renderConfigSection(h, state, store.commit, () => {
      if (onLayoutChange) onLayoutChange();
      render();
    });

    panel.textContent = '';
    panel.append(
      h('div', { class: 'panel-card' }, [
        h('div', { class: 'panel-head' }, [
          h('h2', {}, [t('panel.settings'), h('span', { class: 'ver', text: 'v' + version })]),
          h('button', { class: 'panel-close', type: 'button', text: t('panel.close'), onclick: closePanel })
        ]),
        h('section', { class: 'sec' }, [
          h('h3', { text: t('sec.wallpaper') }),
          wallpaperRow,
          h('div', { class: 'row wrap' }, [
            h('button', { class: 'btn', type: 'button', text: t('wall.upload'), onclick: () => singleInput.click() }),
            h('button', { class: 'btn', type: 'button', text: t('wall.addToRotation'), onclick: () => multiInput.click() }),
            singleInput, multiInput,
            h('span', { class: 'hint-text', text: t('wall.uploadHint') })
          ]),
          h('div', { class: 'row wrap' }, [
            h('button', {
              class: 'btn', type: 'button', text: t('wall.rotate'),
              'aria-pressed': String(!!state.wallpaper.rotate),
              onclick: () => {
                store.commit((s) => { s.wallpaper.rotate = !s.wallpaper.rotate; });
                render();
              }
            }),
            h('span', { class: 'hint-text', text: t('wall.rotationCount', slides.length) })
          ]),
          h('p', { class: 'hint-text', text: t('wall.rotateHint') }),
          slideList,
          h('div', { class: 'row' }, [h('span', { class: 'lbl', text: t('wall.veil') }), dim, veilLabel]),
          h('p', { class: 'hint-text', text: t('wall.veilHint') })
        ]),
        h('section', { class: 'sec' }, [
          h('h3', { text: t('sec.theme') }), themeRow,
          h('div', { class: 'row wrap' }, [schedBtn,
            h('span', { class: 'lbl', text: t('theme.dayStart') }), dayIn,
            h('span', { class: 'lbl', text: t('theme.nightStart') }), nightIn
          ]),
          h('p', { class: 'hint-text', text: t('theme.scheduleHint') })
        ]),
        h('section', { class: 'sec' }, [h('h3', { text: t('sec.language') }), langRow]),
        h('section', { class: 'sec' }, [
          h('h3', { text: t('sec.scale') }),
          h('div', { class: 'row' }, [scaleLabel, scaleSlider])
        ]),
        h('section', { class: 'sec' }, [
          h('h3', { text: t('sec.display') }),
          toggleRow([
            [t('disp.search'), 'search'],
            [t('disp.add'), 'showAdd'],
            [t('disp.zen'), 'zen']
          ]),
          h('p', { class: 'hint-text', text: t('disp.zenHint') })
        ]),
        h('section', { class: 'sec' }, [h('h3', { text: t('sec.engine') }), engineRow]),
        h('section', { class: 'sec' }, [
          h('h3', { text: t('sec.sites') }),
          h('div', { class: 'field' }, [nameInput, urlInput]),
          h('div', { class: 'row wrap' }, [
            h('button', {
              class: 'btn primary', type: 'button', text: t('site.add'),
              onclick: () => {
                const url = normalizeUrl(urlInput.value);
                if (!url) return;
                store.commit((s) => {
                  s.items.push({
                    id: uid(), kind: 'link',
                    title: nameInput.value.trim() || hostOf(url),
                    url, cols: 1, rows: 1
                  });
                });
                nameInput.value = '';
                urlInput.value = '';
                if (onLayoutChange) onLayoutChange();
                render();
              }
            }),
            h('button', { class: 'btn', type: 'button', text: t('site.bookmarks'), onclick: importBookmarks })
          ]),
          h('ul', { class: 'list' }, links.map(linkRow))
        ]),
        configSection,
        syncSection,
        dataSection,
        snapshotSection,
        h('section', { class: 'sec' }, [
          h('h3', { text: t('sec.icons') }),
          iconSection,
          h('div', { class: 'row wrap' }, [stripBtn, trimBtn]),
          h('p', { class: 'hint-text', text: t('icon.customHint') }),
          hiddenBlock
        ]),
        h('section', { class: 'sec' }, [
          h('h3', { text: t('sec.diagnostics') }),
          h('div', { class: 'diag', id: 'diag-icons' }),
          h('div', { class: 'diag', id: 'diag-quota' }),
          h('div', { class: 'row wrap' }, [
            h('button', {
              class: 'btn', type: 'button', text: t('storage.cleanup'),
              onclick: async (e) => {
                const n = await cleanupOrphans(state);
                e.currentTarget.textContent = n ? t('storage.cleaned', n) : t('storage.none');
                quota = await storageUsage();
                fillDiag();
              }
            })
          ]),
          h('div', {
            class: 'diag',
            text: perf ? t('diag.perf', perf.rendered, version) : t('diag.noPerf')
          }),
          h('p', { class: 'hint-text', text: t('diag.zeroNet') })
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
    btn.textContent = t('icon.cleared');
  }

  panel.hidden = true;
  return { open: openPanel, close: closePanel, render };
}
