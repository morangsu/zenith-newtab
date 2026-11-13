/* 统一网格：图标和组件都是网格项，可以拖到任意格子。
   位置以 8 列为基准存 (col, row)，渲染时换算成当前列数；
   如果换算后撞在一起（窗口变窄、尺寸变大），撞的那个顺延到下一个空位。
   这样"拖到哪儿就在哪儿"，又不会被自动流重新排序。 */
import { el, hostOf, initialOf, hueOf } from './util.js';
import { uid, BASE_COLS } from './store.js';
import { widgetByType, WIDGETS } from './registry.js';
import { hydrate } from './iconview.js';
import { bytesToB64 } from './b64.js';
import { sniffImageMime } from './iconproc.js';

/* 单个元素的尺寸上限（列 × 行）。行高 104px，3 行已经 312px，
   再大就超出首屏了；列最多 4 格，即半行。 */
const MAX_COLS = 4;
const MAX_ROWS = 3;

/* 与 CSS 里的 gap 保持一致，用来把鼠标位置换算成格子 */
const GAP = 12;

export function mountBoard(container, store) {
  const state = store.state;
  let cleanups = [];
  let dragId = null;
  let dragGrab = null;
  let dragRect = null;

  function cols() {
    return window.innerWidth < 760 ? 4 : BASE_COLS;
  }

  function scaled(n) {
    return Math.max(1, Math.round((n * cols()) / BASE_COLS));
  }

  /* 8 列坐标 → 当前列数坐标；反向换算在拖放时用 */
  function toCol(col, total = cols()) {
    if (total === BASE_COLS) return col;
    return Math.max(1, Math.round(((col - 1) * total) / BASE_COLS) + 1);
  }

  function toBaseCol(col, total = cols()) {
    if (total === BASE_COLS) return col;
    return Math.max(1, Math.round(((col - 1) * BASE_COLS) / total) + 1);
  }

  /* ---------- 布局解算 ---------- */

  /* 返回 [{ item, c, r, w, h }]，坐标是当前列数下的。
     priorityId 的项先占位——拖动时让被拖的那个优先，被压住的才顺延。 */
  function layoutWith(items, priorityId) {
    const total = cols();
    const occupied = new Set();
    const key = (x, y) => x + ',' + y;

    const fits = (c, r, w, h) => {
      if (c < 1 || c + w - 1 > total || r < 1) return false;
      for (let y = r; y < r + h; y++) {
        for (let x = c; x < c + w; x++) if (occupied.has(key(x, y))) return false;
      }
      return true;
    };
    const mark = (c, r, w, h) => {
      for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) occupied.add(key(x, y));
    };

    /* 有坐标的按坐标排；没有坐标的（旧数据、刚添加的）按数组顺序排到最后 */
    const ordered = items
      .map((item, i) => ({ item, i }))
      .sort((a, b) => {
        const ar = a.item.row || 1e6;
        const br = b.item.row || 1e6;
        if (ar !== br) return ar - br;
        const ac = a.item.col || 1e6;
        const bc = b.item.col || 1e6;
        if (ac !== bc) return ac - bc;
        return a.i - b.i;
      });

    if (priorityId) {
      const idx = ordered.findIndex((x) => x.item.id === priorityId);
      if (idx > 0) ordered.unshift(ordered.splice(idx, 1)[0]);
    }

    let bottom = 1;
    const out = [];
    for (const { item } of ordered) {
      const w = scaled(item.cols);
      const h = item.rows || 1;
      const prefC = item.col ? toCol(item.col, total) : 0;
      const prefR = item.row || 0;

      if (prefC && prefR && fits(prefC, prefR, w, h)) {
        mark(prefC, prefR, w, h);
        out.push({ item, c: prefC, r: prefR, w, h });
        bottom = Math.max(bottom, prefR + h);
        continue;
      }

      /* 没坐标或位置被占：从它想要的行往下找第一个能放下的地方。
         没有坐标的一定从第 1 行开始扫——这样旧数据（都还没有坐标）会按原来的
         顺序紧凑排好，而不是每项各占一行 */
      const start = prefR || 1;
      let done = false;
      for (let r = start; !done && r < start + 400; r++) {
        for (let c = 1; c + w - 1 <= total; c++) {
          if (fits(c, r, w, h)) {
            mark(c, r, w, h);
            out.push({ item, c, r, w, h });
            bottom = Math.max(bottom, r + h);
            done = true;
            break;
          }
        }
      }
    }
    return out;
  }

  const visibleItems = () => state.items.filter((i) => !i.hidden);

  function layout(priorityId) {
    return layoutWith(visibleItems(), priorityId);
  }

  /* ---------- 拖放落点 ---------- */

  function metrics() {
    const rect = container.getBoundingClientRect();
    const total = cols();
    const cellW = (rect.width - GAP * (total - 1)) / total;
    const rowH = parseFloat(getComputedStyle(container).gridAutoRows) || 104;
    return { rect, total, cellW, rowH };
  }

  function cellAt(clientX, clientY) {
    const { rect, total, cellW, rowH } = metrics();
    const x = clientX - (dragGrab ? dragGrab.x : 0) - rect.left;
    const y = clientY - (dragGrab ? dragGrab.y : 0) - rect.top;
    const c = Math.min(total, Math.max(1, Math.floor(x / (cellW + GAP)) + 1));
    const r = Math.max(1, Math.floor(y / (rowH + GAP)) + 1);
    return { c, r };
  }

  function hintNode() {
    let node = container.querySelector('.drop-hint');
    if (!node) {
      node = el('div', { class: 'drop-hint', 'aria-hidden': 'true' });
      container.append(node);
    }
    return node;
  }

  function showHint(c, r, item) {
    const { cellW, rowH } = metrics();
    const node = hintNode();
    const w = scaled(item.cols);
    const h = item.rows || 1;
    /* 落点超出右边界时整体左移，避免提示框跑出网格 */
    const cAdj = Math.min(c, cols() - w + 1);
    node.style.display = 'block';
    node.style.left = (cAdj - 1) * (cellW + GAP) + 'px';
    node.style.top = (r - 1) * (rowH + GAP) + 'px';
    node.style.width = w * cellW + (w - 1) * GAP + 'px';
    node.style.height = h * rowH + (h - 1) * GAP + 'px';
  }

  function hideHint() {
    const node = container.querySelector('.drop-hint');
    if (node) node.style.display = 'none';
  }

  /* 把某项放到指定格；被压住的项顺延，并把结果写回（否则下次渲染又会撞） */
  function placeAt(itemId, c, r) {
    const total = cols();
    store.commit((s) => {
      const it = s.items.find((x) => x.id === itemId);
      if (!it) return;
      it.col = toBaseCol(c, total);
      it.row = r;

      for (const p of layoutWith(s.items, itemId)) {
        /* 只回写已经有过坐标的项，避免把"未定位"的新项也钉死在当前列数下 */
        if (!p.item.col) continue;
        p.item.col = toBaseCol(p.c, total);
        p.item.row = p.r;
      }
    });
    render();
  }

  /* ---------- 交互 ---------- */

  function sizeLimits() {
    return { cols: Math.min(MAX_COLS, cols()), rows: MAX_ROWS };
  }

  function setSize(item, c, r) {
    const lim = sizeLimits();
    const nc = Math.max(1, Math.min(lim.cols, c));
    const nr = Math.max(1, Math.min(lim.rows, r));
    store.commit(() => {
      item.cols = nc;
      item.rows = nr;
    });
    render();
  }

  /* 尺寸选择器：点尺寸按钮弹一个 4×3 的格子矩阵，
     悬停预览要占的区域，点一下直接定档——比循环点十几次省事。 */
  function openSizePicker(item, anchor) {
    const old = document.getElementById('size-picker');
    if (old) {
      old.remove();
      return;
    }
    const lim = sizeLimits();
    const box = el('div', { class: 'size-picker', id: 'size-picker' });
    const grid = el('div', { class: 'size-grid' });
    grid.style.gridTemplateColumns = "repeat(" + lim.cols + ", 22px)";
    const cells = [];
    const label = el('div', { class: 'size-label', text: item.cols + '×' + item.rows });

    const preview = (c, r) => {
      for (const cell of cells) {
        const on = Number(cell.dataset.c) <= c && Number(cell.dataset.r) <= r;
        cell.classList.toggle('on', on);
      }
      label.textContent = c + '×' + r;
    };

    for (let r = 1; r <= lim.rows; r++) {
      for (let c = 1; c <= lim.cols; c++) {
        const cell = el('button', {
          class: 'size-cell',
          type: 'button',
          'aria-label': c + '×' + r,
          onclick: () => {
            setSize(item, c, r);
            box.remove();
          }
        });
        cell.dataset.c = c;
        cell.dataset.r = r;
        cell.addEventListener('mouseenter', () => preview(c, r));
        cells.push(cell);
        grid.append(cell);
      }
    }
    preview(item.cols, item.rows);
    box.append(grid, label);
    document.body.append(box);

    const rect = anchor.getBoundingClientRect();
    box.style.position = 'fixed';
    box.style.left = Math.min(window.innerWidth - box.offsetWidth - 8, rect.left) + 'px';
    box.style.top = rect.bottom + 6 + 'px';
    if (rect.bottom + box.offsetHeight + 8 > window.innerHeight) {
      box.style.top = Math.max(8, rect.top - box.offsetHeight - 6) + 'px';
    }

    setTimeout(() => {
      const close = (e) => {
        if (!box.contains(e.target) && !anchor.contains(e.target)) {
          box.remove();
          document.removeEventListener('click', close);
        }
      };
      document.addEventListener('click', close);
    }, 0);
  }

  function makeCtx(item) {
    return {
      id: item.id,
      data(defaults) {
        if (!state.widgetData) state.widgetData = {};
        if (!state.widgetData[item.id]) {
          state.widgetData[item.id] = JSON.parse(JSON.stringify(defaults || {}));
        } else {
          for (const k of Object.keys(defaults || {})) {
            if (!(k in state.widgetData[item.id])) state.widgetData[item.id][k] = defaults[k];
          }
        }
        return state.widgetData[item.id];
      },
      save() {
        store.persist();
      }
    };
  }



  function hideItem(item) {
    store.commit((s) => {
      const it = s.items.find((x) => x.id === item.id);
      if (it) it.hidden = true;
    });
    render();
  }

  /* ---------- 自定义图标 ---------- */

  function toast(msg) {
    const t = el('div', { class: 'toast', text: msg });
    document.body.append(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 320);
    }, 2400);
  }

  /* 上传文件的硬上限。真正的体积控制在后面的降采样：
     位图统一缩到最长边 192px 转 PNG（一般只有几十 KB），SVG 保留原文。 */
  const CUSTOM_MAX_RAW = 2 * 1024 * 1024;

  async function buildCustomIcon(file) {
    if (file.size > CUSTOM_MAX_RAW) return { error: '文件超过 2MB，先压一压再上传' };

    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      return { error: '读不出文件内容' };
    }

    /* 文件的 type 经常是空的，靠魔数认，认不出再看扩展名 */
    const mime = sniffImageMime(bytes, file.name);
    if (!mime) return { error: '不是可识别的图片（支持 PNG/JPEG/WebP/GIF/SVG/ICO/BMP）' };

    const dataUrl = 'data:' + mime + ';base64,' + bytesToB64(bytes);

    /* SVG 是矢量，缩放由渲染端做，原文保留 */
    if (mime === 'image/svg+xml') return { icon: dataUrl };

    /* 位图降到最长边 192px。转 PNG 而不是保留原格式：统一保住透明通道，
       JPEG 也顺便不再二次压缩。动态 GIF 会取第一帧。 */
    try {
      const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
      const scale = Math.min(1, 192 / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      return { icon: c.toDataURL('image/png') };
    } catch {
      return { error: '这张图片解不出来，换一张试试' };
    }
  }

  function pickCustomIcon(item) {
    const input = el('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon,image/bmp,.svg'
    });
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      const res = await buildCustomIcon(file);
      if (res.error) {
        toast(res.error);
        return;
      }
      store.commit((s) => {
        const it = s.items.find((x) => x.id === item.id);
        if (it) it.icon = res.icon;
      });
      render();
      toast('图标已更新');
    });
    document.body.append(input);
    input.click();
  }

  function resetCustomIcon(item) {
    store.commit((s) => {
      const it = s.items.find((x) => x.id === item.id);
      if (it) delete it.icon;
    });
    render();
  }

  /* 右键菜单：隐藏（可恢复）和移除（彻底删掉）分开，
     以前只有 confirm 删除，误删只能重加一遍 */
  function openTileMenu(item, x, y) {
    const old = document.getElementById('tile-menu');
    if (old) old.remove();

    const menu = el('div', { class: 'tile-menu', id: 'tile-menu' });

    /* 只有链接有图标和名称，组件卡片不放这些入口 */
    if (item.kind === 'link') {
      menu.append(
        el('button', {
          class: 'tile-menu-item',
          type: 'button',
          text: item.icon ? '更换图标…' : '自定义图标…',
          onclick: () => {
            menu.remove();
            pickCustomIcon(item);
          }
        }),
        el('button', {
          class: 'tile-menu-item',
          type: 'button',
          text: item.hideName ? '显示名称' : '隐藏名称',
          onclick: () => {
            menu.remove();
            store.commit((s) => {
              const it = s.items.find((x) => x.id === item.id);
              if (it) it.hideName = !it.hideName;
            });
            render();
          }
        })
      );
      if (item.icon) {
        menu.append(
          el('button', {
            class: 'tile-menu-item',
            type: 'button',
            text: '恢复默认图标',
            onclick: () => {
              menu.remove();
              resetCustomIcon(item);
            }
          })
        );
      }
    }

    menu.append(
      el('button', {
        class: 'tile-menu-item',
        type: 'button',
        text: '隐藏',
        onclick: () => {
          hideItem(item);
          menu.remove();
        }
      }),
      el('button', {
        class: 'tile-menu-item danger',
        type: 'button',
        text: '移除',
        onclick: () => {
          menu.remove();
          if (window.confirm(`移除「${item.title || item.type}」？（不会影响书签）`)) removeItem(item);
        }
      })
    );
    document.body.append(menu);

    menu.style.position = 'fixed';
    menu.style.left = Math.min(x, window.innerWidth - menu.offsetWidth - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 8) + 'px';

    setTimeout(() => {
      const close = (e) => {
        if (!menu.contains(e.target)) {
          menu.remove();
          document.removeEventListener('click', close);
        }
      };
      document.addEventListener('click', close);
    }, 0);
  }

  function removeItem(item) {
    store.commit((s) => {
      s.items = s.items.filter((x) => x.id !== item.id);
      if (item.kind === 'widget' && s.widgetData) delete s.widgetData[item.id];
    });
    render();
  }

  function bindDrag(node, item, handle) {
    const source = handle || node;
    source.draggable = true;
    source.addEventListener('dragstart', (e) => {
      dragId = item.id;
      const r = node.getBoundingClientRect();
      dragGrab = { x: e.clientX - r.left, y: e.clientY - r.top };
      dragRect = r;
      node.classList.add('dragging');
      container.classList.add('dragging-active');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.id);
      }
    });
    source.addEventListener('dragend', () => {
      dragId = null;
      dragGrab = null;
      node.classList.remove('dragging');
      container.classList.remove('dragging-active');
      hideHint();
    });
  }

  let lastHint = '';
  container.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const item = state.items.find((x) => x.id === dragId);
    if (!item) return;
    const { c, r } = cellAt(e.clientX, e.clientY);
    const sig = c + ',' + r;
    if (sig !== lastHint) {
      lastHint = sig;
      showHint(c, r, item);
    }
  });

  container.addEventListener('dragleave', (e) => {
    if (e.target === container) hideHint();
  });

  container.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const item = state.items.find((x) => x.id === dragId);
    const id = dragId;
    hideHint();
    lastHint = '';
    container.classList.remove('dragging-active');
    if (!item) return;
    const { c, r } = cellAt(e.clientX, e.clientY);
    const cAdj = Math.min(c, Math.max(1, cols() - scaled(item.cols) + 1));
    placeAt(id, cAdj, r);
  });

  /* ---------- 图标 ---------- */

  /* 图标尺寸按格子的**实际像素**算，而不是按行数加常数——
     不然 4×3 的格子会像一间空房间。横排受高度限制，竖排取宽高里小的那个。
     隐藏名称后不需要给文字留位置，图标可以再大一档。 */
  function iconPx(item, m) {
    const { cellW, rowH } = m;
    const c = item.cols;
    const r = item.rows || 1;
    const w = c * cellW + (c - 1) * GAP;
    const h = r * rowH + (r - 1) * GAP;
    if (r === 1 && c > 1) return Math.round(Math.min(h - 18, 64));
    /* 占短边的 60%，再被「高度减去名称」卡一道，最后兜个上限 */
    const base = Math.min(w, h) * 0.6;
    const cap = item.hideName ? h - 16 : h - 44;
    return Math.round(Math.max(46, Math.min(base, cap, 280)));
  }

  function linkNode(item, m) {
    const node = el('a', {
      class: 'tile' + (item.hideName ? ' bare' : ''),
      href: item.url,
      'data-id': item.id,
      title: item.title || item.url
    });
    /* 只有「一行高、多列宽」才横排（图标左、名称右）；
       多行的是大图标，名称放下面 */
    if ((item.rows || 1) === 1 && item.cols > 1) node.classList.add('wide');

    const icon = el('span', { class: 'icon', 'data-url': item.url });
    /* 自定义图标走独立的水合路径（favicon.js 里按 data-custom 分流） */
    if (item.icon) icon.setAttribute('data-custom', '1');
    const img = el('img', { alt: '' });
    img.decoding = 'async';
    const letter = el('span', { class: 'letter', text: initialOf(item.title || hostOf(item.url)) });
    const hue = hueOf(hostOf(item.url) || item.title || 'x');
    letter.style.background = `hsl(${hue} 46% 52%)`;
    icon.append(img, letter);

    const px = iconPx(item, m);
    icon.style.width = px + 'px';
    icon.style.height = px + 'px';
    /* 大图标下面留的间距要跟着放大，否则名称像贴在图标上 */
    if (px > 90) node.style.gap = Math.round(px * 0.1) + 'px';
    icon.style.borderRadius = Math.round(px * 0.26) + 'px';

    const name = item.hideName ? null : el('span', { class: 'name', text: item.title });
    if (name) {
      if (px >= 150) name.style.fontSize = 'calc(17px * var(--scale))';
      else if (px >= 110) name.style.fontSize = 'calc(15.5px * var(--scale))';
      else if (px >= 76) name.style.fontSize = 'calc(14px * var(--scale))';
      else if (px >= 62) name.style.fontSize = 'calc(13px * var(--scale))';
    }

    const size = el('span', {
      class: 'tile-size',
      role: 'button',
      title: '调整尺寸',
      text: item.cols + '×' + item.rows,
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        openSizePicker(item, e.currentTarget);
      }
    });

    if (name) node.append(icon, name, size);
    else node.append(icon, size);

    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTileMenu(item, e.clientX, e.clientY);
    });

    bindDrag(node, item);
    return node;
  }

  /* ---------- 组件卡片 ---------- */

  function cardNode(item) {
    const def = widgetByType(item.type);
    const node = el('article', { class: 'card' });

    const head = el(
      'header',
      { class: 'card-head' },
      el('span', { class: 'card-title', text: def.name }),
      el(
        'span',
        { class: 'card-tools' },
        el('button', {
          class: 'card-btn',
          type: 'button',
          text: `${item.cols}×${item.rows}`,
          title: '调整尺寸',
          onclick: (e) => openSizePicker(item, e.currentTarget)
        }),
        el('button', {
          class: 'card-btn',
          type: 'button',
          text: '×',
          title: '移除组件',
          onclick: () => removeItem(item)
        })
      )
    );

    const body = el('div', { class: 'card-body' });
    node.append(head, body);

    try {
      const cleanup = def.mount(body, makeCtx(item));
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    } catch (err) {
      body.append(el('div', { class: 'w-empty', text: '组件出错：' + (err && err.message) }));
    }

    bindDrag(node, item, head);
    return node;
  }

  /* ---------- 添加组件 ---------- */

  function openPicker(anchor) {
    const old = document.getElementById('widget-picker');
    if (old) {
      old.remove();
      return;
    }

    const picker = el('div', { class: 'picker', id: 'widget-picker' });
    for (const def of WIDGETS) {
      picker.append(
        el('button', {
          class: 'picker-item',
          type: 'button',
          text: def.name,
          onclick: () => {
            store.commit((s) => {
              /* 新组件放在现有内容的下方，而不是钻进第 1 行的空隙里 */
              const laid = layoutWith(s.items, null);
              const lastRow = laid.reduce((m, p) => Math.max(m, p.r + p.h), 1);
              s.items.push({
                id: uid(),
                kind: 'widget',
                type: def.type,
                cols: Math.min(cols(), def.cols || 1),
                rows: def.rows || 1,
                col: 1,
                row: lastRow
              });
            });
            picker.remove();
            render();
          }
        })
      );
    }

    document.body.append(picker);
    const rect = anchor.getBoundingClientRect();
    picker.style.position = 'fixed';
    picker.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
    picker.style.bottom = window.innerHeight - rect.top + 6 + 'px';

    setTimeout(() => {
      const close = (e) => {
        if (!picker.contains(e.target) && !anchor.contains(e.target)) {
          picker.remove();
          document.removeEventListener('click', close);
        }
      };
      document.addEventListener('click', close);
    }, 0);
  }

  function ensureAddButton() {
    let btn = document.getElementById('widget-add');
    if (!btn) {
      btn = el('button', { class: 'widget-add', id: 'widget-add', type: 'button', text: '＋ 添加组件' });
      container.after(btn);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openPicker(btn);
      });
    }
    btn.hidden = !state.ui.showAdd;
    return btn;
  }

  /* ---------- 渲染 ---------- */

  function render() {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        /* 忽略 */
      }
    }
    cleanups = [];
    container.textContent = '';

    const m = metrics();
    for (const p of layout()) {
      const node = p.item.kind === 'link' ? linkNode(p.item, m) : cardNode(p.item);
      /* 位置由布局解算决定，不用 CSS 的自动流——自动流会把拖过的项重新排序 */
      node.style.gridColumn = `${p.c} / span ${p.w}`;
      node.style.gridRow = `${p.r} / span ${p.h}`;
      container.append(node);
    }

    ensureAddButton();
    requestAnimationFrame(() => hydrate(container, state));
  }

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 200);
  });

  render();
  return { render };
}
