/* 经典脚本，放在 <head> 里同步执行：在 CSS 之后、首帧之前把壁纸与主题定下来，
   这样第一次绘制就是最终外观，不会出现闪白或闪灰。约 0.3ms。 */
(function () {
  'use strict';
  var t0 = performance.now();
  var snap = null;
  try {
    var raw = localStorage.getItem('zl.state');
    if (raw) snap = JSON.parse(raw);
  } catch (e) {
    snap = null;
  }

  var root = document.documentElement;
  var wp = (snap && snap.wallpaper) || {};
  root.setAttribute('data-wallpaper', wp.preset || 'aurora');
  /* 图片壁纸和预设渐变要区别对待：照片的明暗是不均匀的，文字需要额外保底，
     卡片也需要更实的底色。首帧前就定下来，避免切换时闪一下。 */
  root.setAttribute('data-wall', wp.type === 'image' ? 'image' : 'preset');

  var mode = (snap && snap.theme && snap.theme.mode) || 'auto';
  var dark =
    mode === 'dark' ||
    (mode !== 'light' &&
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-color-scheme: dark)').matches);

  /* 打底色：这是 CSS 加载前浏览器画的那一帧，默认是白的。
     跟谁走有讲究：**跟壁纸的明暗走**，不是跟浏览器主题——
     浏览器深色 + 浅色壁纸时，深打底会让壁纸出现的那一帧更刺眼。
     优先级：壁纸均色（上传时算好的）→ 壁纸明暗倾向 → 浏览器主题。 */
  var tone = null;
  try {
    tone = localStorage.getItem('zl.wallpaper.tone');
  } catch (e) {
    tone = null;
  }

  var base = null;
  if (wp.type === 'image') {
    try {
      var avg = localStorage.getItem('zl.wallpaper.avg');
      if (avg && /^\d{1,3},\d{1,3},\d{1,3}$/.test(avg)) base = 'rgb(' + avg + ')';
    } catch (e) {
      base = null;
    }
    if (!base && tone === 'light') base = '#eef0f2';
    if (!base && tone === 'dark') base = '#16181c';
  }
  if (!base) base = dark ? '#16181c' : '#f4f3ef';
  root.style.backgroundColor = base;

  /* 图片壁纸首帧缓存：IndexedDB 是异步的，boot 读不了；
     上传/导入时把压缩预览存进了 localStorage，这里同步上屏——
     首帧就是壁纸本体，之后主流程异步加载的原图只是无缝覆盖。 */
  if (wp.type === 'image') {
    try {
      var shot = localStorage.getItem('zl.wallpaper.shot');
      if (shot) {
        root.style.backgroundImage = 'url("' + shot + '")';
        root.style.backgroundSize = 'cover';
        root.style.backgroundPosition = 'center';
      }
    } catch (e) {
      /* 没有缓存就回退旧行为：主流程异步后再上壁纸 */
    }
  }

  /* 自动配色的结论也缓存着（zl.adapt），首帧前直接应用——
     否则文字颜色要等壁纸采样完才翻转，又是一次可见的闪。
     没有正式采样结论时，用壁纸整体的粗采样方向兜底。 */
  try {
    var adapt = JSON.parse(localStorage.getItem('zl.adapt') || 'null');
    if (adapt && adapt.tone && wp.type === 'image') {
      /* key 首段是 imageKey，换过壁纸的缓存不认 */
      if (!adapt.key || !wp.imageKey || adapt.key.split('|')[0] === wp.imageKey) {
        root.setAttribute('data-adapt', adapt.tone);
      } else if (tone === 'light' || tone === 'dark') {
        root.setAttribute('data-adapt', tone);
      }
    } else if (wp.type === 'image' && (tone === 'light' || tone === 'dark')) {
      root.setAttribute('data-adapt', tone);
    }
  } catch (e) {
    /* 采样还没做过：主流程会补 */
  }

  if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
  else root.removeAttribute('data-theme');

  /* 遮罩强度：颜色由主题决定（深色主题压暗、浅色主题提亮），这里只给强度。
     照片和预设各记一个值；照片还要看是不是「跟随系统」——
     自动配色已经挑好了文字色，遮罩只需要很轻的一点，再重就是一层白雾。 */
  var veil =
    wp.type === 'image'
      ? mode === 'light' || mode === 'dark'
        ? wp.imageDim
        : wp.adaptDim
      : wp.dim;
  if (typeof veil === 'number' && veil > 0) {
    root.style.setProperty('--veil-a', String(veil));
  }

  /* 字号缩放和显示开关都要在首帧前定下来，否则会看到一次明显的跳变 */
  var ui = (snap && snap.ui) || {};
  if (typeof ui.scale === 'number' && ui.scale > 0) {
    root.style.setProperty('--scale', String(ui.scale));
  }
  root.setAttribute('data-zen', ui.zen === true ? '1' : '0');
  root.setAttribute('data-search', ui.search === false ? '0' : '1');

  window.__ZL_BOOT = { t0: t0, snap: snap };
})();
