/* 自定义/站点图标的纯处理函数：格式嗅探、透明检测、白底裁切。
   全部只操作 Uint8ClampedArray / 字节，不碰 DOM，Node 里可以直接单测。
   canvas 相关的编排在 iconview.js。 */

/* ---------- 格式识别 ---------- */

/* 用户上传的文件 type 经常是空的（尤其拖拽和某些系统），靠魔数认一遍，
   认不出再靠扩展名。SVG 是文本格式，没有魔数，直接找 <svg 标记。 */
export function sniffImageMime(bytes, filename) {
  if (!bytes || bytes.length < 4) return null;

  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ascii = (start, len) => {
    let s = '';
    for (let i = start; i < Math.min(start + len, u8.length); i++) s += String.fromCharCode(u8[i]);
    return s;
  };

  /* PNG */
  if (u8[0] === 0x89 && ascii(1, 3) === 'PNG') return 'image/png';
  /* JPEG */
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'image/jpeg';
  /* GIF */
  if (ascii(0, 3) === 'GIF') return 'image/gif';
  /* WebP：RIFF....WEBP */
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  /* ICO / CUR */
  if (u8[0] === 0 && u8[1] === 0 && u8[2] === 1 && u8[3] === 0) return 'image/x-icon';
  /* BMP */
  if (u8[0] === 0x42 && u8[1] === 0x4d) return 'image/bmp';

  /* SVG：前 1KB 内出现 <svg（XML 声明和注释可能在前面） */
  const head = ascii(0, 1024).toLowerCase();
  if (head.includes('<svg')) return 'image/svg+xml';

  /* 魔数不认识，看扩展名 */
  const name = String(filename || '').toLowerCase();
  const extMap = [
    ['.svg', 'image/svg+xml'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.webp', 'image/webp'],
    ['.gif', 'image/gif'],
    ['.ico', 'image/x-icon'],
    ['.bmp', 'image/bmp']
  ];
  for (const [suffix, mime] of extMap) {
    if (name.endsWith(suffix)) return mime;
  }
  return null;
}

/* ---------- 透明检测 ---------- */

/* 有没有透明像素。stride 采样即可——目的是分叉「要不要走白底处理」，
   不是精确测量，步进 4 个像素足够可靠且快。 */
export function hasAlphaChannel(d, w, h) {
  const n = w * h;
  for (let p = 0; p < n; p += 4) {
    if (d[p * 4 + 3] < 250) return true;
  }
  return false;
}

/* ---------- 内容统计 ---------- */

/* 内容包围盒（alpha > 8 的像素范围）和盒内不透明占比。
   占比高说明内容把包围盒填满了——白底板就是这种形态；
   细笔画 logo 的包围盒大部分是透明的，不值得做白底处理。 */
export function contentStats(d, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1, opaque = 0;
  const n = w * h;
  for (let p = 0; p < n; p++) {
    if (d[p * 4 + 3] > 8) {
      opaque++;
      const x = p % w;
      const y = (p - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  return { minX, minY, maxX, maxY, bw, bh, bboxOpaqueRatio: opaque / (bw * bh), opaque };
}

const NEAR_WHITE = (d, i) => d[i] > 234 && d[i + 1] > 234 && d[i + 2] > 234 && d[i + 3] > 190;

/* ---------- 白底裁切 ---------- */

/* 去掉「贴着内容的白色底板」：从画布四边出发做泛洪填充。
   填充可以**穿过完全透明的像素**继续传播——很多 favicon 的白色方块
   四周留了一圈透明边距，只从字面边缘找白色会什么都找不到，
   这正是「去白底无效」的第二个根因。

   传播规则：
   - 透明像素（alpha ≤ 8）：只通行，不动它
   - 近白不透明像素：清成透明，继续传播
   - 其它颜色：挡住

   这样图标内部的白色（logo 里的白字、白色高光）被有色区域包着，
   不会与边缘连通，不受影响。返回清掉的近白像素数。 */
export function trimWhiteEdges(d, w, h) {
  if (w < 3 || h < 3) return 0;

  const total = w * h;
  const seen = new Uint8Array(total);
  const stack = [];

  const push = (x, y) => {
    const p = y * w + x;
    if (seen[p]) return;
    const i = p * 4;
    /* 透明的可以反复路过的前提是标记已见——但透明像素也要标记，
       否则同一个透明像素会被四邻重复入栈 */
    seen[p] = 1;
    if (d[i + 3] <= 8 || NEAR_WHITE(d, i)) stack.push(p);
  };

  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }

  let removed = 0;
  while (stack.length) {
    const p = stack.pop();
    const i = p * 4;
    /* 不透明且近白 → 清成透明；透明像素只负责把填充传过去。
       这两行顺序不能反：先清再传播，清掉的像素同样要扩散邻居 */
    if (d[i + 3] > 8) {
      d[i + 3] = 0;
      removed++;
    }

    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  return removed;
}

/* 裁完之后不透明像素还剩多少（0..1）。低于阈值说明主体本身
   基本是白的、贴着边（比如白色的字母标），裁了就没了，调用方应放弃。 */
export function remainingOpaqueRatio(d, w, h) {
  let opaque = 0;
  const n = w * h;
  for (let p = 0; p < n; p++) {
    if (d[p * 4 + 3] > 0) opaque++;
  }
  return opaque / n;
}

/* 白底处理的完整判定：闸门 + 裁切。在副本上做，全部门闸通过才把
   结果写回原缓冲——中途放弃时原图字节保持不变，调用方不用关心回滚。 */
export function stripBackdropPixels(d, w, h) {
  /* 内容得把包围盒填得比较满——白底板的形态是「方块里包着 logo」；
     细笔画 logo 的包围盒大多是透明的，处理它没有意义 */
  const stats = contentStats(d, w, h);
  if (!stats || stats.bboxOpaqueRatio < 0.55) return false;

  const work = new Uint8ClampedArray(d);
  const removed = trimWhiteEdges(work, w, h);
  if (!removed) return false;
  /* 接近全白：主体本身就是白的，裁了只剩空气 */
  if (removed / (w * h) > 0.96) return false;
  /* 剩余太少：白 logo 被整只吃掉了，放弃保持原图 */
  if (remainingOpaqueRatio(work, w, h) < 0.08) return false;

  for (let p = 0; p < w * h; p++) d[p * 4 + 3] = work[p * 4 + 3];
  return true;
}
