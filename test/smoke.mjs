/* 冒烟测试：纯函数 + 构建产物守卫。无第三方依赖，node test/smoke.mjs 直接跑。 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { canonical, sha256Hex } from '../src/js/hash.js';
import { bytesToB64, b64ToBytes } from '../src/js/b64.js';
import { configOf, shouldSkip, FAIL_BACKOFF, withoutIcons, buildSyncText } from '../src/js/sync.js';
import { solarToLunar, dayName, monthName } from '../src/js/lunar.js';
import { parseDataImage, ICON_MAX_BYTES } from '../src/js/favicon.js';
import { matchLocal, buildUrlForQuery, ENGINES } from '../src/js/search.js';
import { evaluate } from '../src/js/widgets/calculator.js';
import { toChineseAmount } from '../src/js/widgets/money.js';
import { convert } from '../src/js/widgets/unit.js';
import { normalizeUrl, looksLikeUrl, subseqScore, hostOf, pickTone } from '../src/js/util.js';
import { normalizeWallpaper } from '../src/js/store.js';
import { sameContent } from '../src/js/sync.js';
import { sniffImageMime, hasAlphaChannel, trimWhiteEdges, remainingOpaqueRatio, stripBackdropPixels } from '../src/js/iconproc.js';

let pass = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
  } else {
    failures.push(name + (extra ? '  → ' + extra : ''));
  }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ---------- 农历：用真实日期做锚点 ---------- */
eq('2026-10-30 应为 九月廿一', solarToLunar(2026, 10, 30).monthText + solarToLunar(2026, 10, 30).dayText, '九月廿一');
eq('2026 春节 02-17 应为 正月初一', (() => { const r = solarToLunar(2026, 2, 17); return r.monthText + r.dayText; })(), '正月初一');
eq('2025 春节 01-29 应为 正月初一', (() => { const r = solarToLunar(2025, 1, 29); return r.monthText + r.dayText; })(), '正月初一');
eq('2024 春节 02-10 应为 正月初一', (() => { const r = solarToLunar(2024, 2, 10); return r.monthText + r.dayText; })(), '正月初一');
eq('2026 干支应为 丙午', solarToLunar(2026, 10, 30).ganzhi, '丙午');
eq('2026 生肖应为 马', solarToLunar(2026, 10, 30).zodiac, '马');
eq('闰月存在性 2020 闰四月', solarToLunar(2020, 6, 1).isLeap || solarToLunar(2020, 5, 25).isLeap, true);
ok('日期名 初一', dayName(1) === '初一');
ok('日期名 二十', dayName(20) === '二十');
ok('日期名 三十', dayName(30) === '三十');
ok('月份名 闰月', monthName(4, true) === '闰四月');

/* ---------- 图标：只吃 data:，且限体积 ---------- */
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const parsed = parseDataImage(PNG_1PX);
ok('合法 data:image 可解析', !!parsed && parsed.mime === 'image/png');
ok('解码字节数 > 0', !!parsed && parsed.bytes > 0 && parsed.data.length === parsed.bytes);
ok('拒绝 http(s) 地址', parseDataImage('https://a.com/favicon.ico') === null);
ok('拒绝 chrome: 内部图标', parseDataImage('chrome://global/skin/icons/default.png') === null);
ok('拒绝空值', parseDataImage(undefined) === null);
ok('拒绝非图片 data:', parseDataImage('data:text/html;base64,PHNjcmlwdD4=') === null);
ok('拒绝超限体积', parseDataImage('data:image/png;base64,' + 'A'.repeat(ICON_MAX_BYTES * 4)) === null);

/* ---------- 搜索 ---------- */
const cands = [
  { title: '哔哩哔哩', url: 'https://www.bilibili.com/', kind: '站点' },
  { title: 'GitHub', url: 'https://github.com/', kind: '站点' },
  { title: '知乎', url: 'https://www.zhihu.com/', kind: '站点' }
];
eq('搜「bili」命中哔哩哔哩', matchLocal('bili', cands)[0].title, '哔哩哔哩');
eq('搜「知乎」命中知乎', matchLocal('知乎', cands)[0].title, '知乎');
eq('搜「hub」命中 GitHub（子序列）', matchLocal('hub', cands)[0].title, 'GitHub');
eq('无匹配返回空', matchLocal('zzzzz', cands).length, 0);
eq('网址直开', buildUrlForQuery('bing', 'example.com'), 'https://example.com');
eq('搜索走引擎', buildUrlForQuery('bing', '火狐 图标').startsWith('https://www.bing.com/search?q='), true);
ok('网址识别', looksLikeUrl('github.com') && looksLikeUrl('https://a.cn/x') && !looksLikeUrl('火狐 图标'));
eq('补全协议', normalizeUrl('github.com'), 'https://github.com');
ok('子序列打分递减', subseqScore('abc', 'ab') > subseqScore('xxabc', 'ab'));
eq('host 提取', hostOf('https://www.bilibili.com/video'), 'www.bilibili.com');
eq('引擎表非空', ENGINES.length >= 4, true);

/* ---------- 计算器：递归下降，不能用 eval ---------- */
eq('1+2*3', evaluate('1+2*3'), 7);
eq('(1+2)*3', evaluate('(1+2)*3'), 9);
eq('一元负号 -2*3', evaluate('-2*3'), -6);
eq('嵌套括号', evaluate('2*(3+(4-1))'), 12);
eq('小数', evaluate('0.1+0.2'), 0.30000000000000004);
eq('除零返回 null', evaluate('10/0'), null);
eq('残缺表达式返回 null', evaluate('1+'), null);
eq('非法字符返回 null', evaluate('1+a'), null);
eq('空串返回 null', evaluate('   '), null);

/* ---------- 大写金额 ---------- */
eq('0 元', toChineseAmount(0), '零元整');
eq('1 元', toChineseAmount(1), '壹元整');
eq('10 元', toChineseAmount(10), '壹拾元整');
eq('100.5 元', toChineseAmount(100.5), '壹佰元伍角');
eq('1001 元', toChineseAmount(1001), '壹仟零壹元整');
eq('10000 元', toChineseAmount(10000), '壹万元整');
eq('10001 元', toChineseAmount(10001), '壹万零壹元整');
eq('亿级', toChineseAmount(123456789.12), '壹亿贰仟叁佰肆拾伍万陆仟柒佰捌拾玖元壹角贰分');
eq('角位为零补零', toChineseAmount(100.05), '壹佰元零伍分');

/* ---------- 单位换算 ---------- */
eq('1000 米 = 1 千米', convert('length', 'm', 'km', 1000), 1);
eq('100 摄氏度 = 212 华氏度', Math.round(convert('temp', 'c', 'f', 100)), 212);
eq('1 千克 ≈ 2.2046 磅', Math.round(convert('weight', 'kg', 'lb', 1) * 10000) / 10000, 2.2046);
eq('非法输入返回 null', convert('length', 'm', 'km', 'abc'), null);

/* ---------- 导出包用的二进制编解码 ---------- */
const small = new Uint8Array([0, 1, 2, 253, 254, 255]);
eq('base64 往返（小数据）', Array.from(b64ToBytes(bytesToB64(small))).join(','), '0,1,2,253,254,255');
eq('base64 编码结果正确', bytesToB64(small), Buffer.from(small).toString('base64'));

const big = new Uint8Array(300000);
for (let i = 0; i < big.length; i++) big[i] = i % 256;
const roundBig = b64ToBytes(bytesToB64(big));
eq('base64 往返（300KB，不吃栈）', roundBig.length, big.length);
eq('base64 往返（300KB，内容一致）', roundBig[299999], big[299999]);
ok('base64 忽略空白字符', b64ToBytes('AAEC\nAwQF').length === 6);

/* ---------- 同步内核：与页面实现必须完全一致 ---------- */
const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url));
vm.runInThisContext(readFileSync(join(SRC_ROOT, 'sync-core.js'), 'utf8'), {
  filename: 'sync-core.js'
});
const ZL = globalThis.ZLSync;

ok('sync-core 载入成功', !!(ZL && ZL.canonical));
eq(
  'canonical 与页面实现一致（嵌套 + 乱序键）',
  ZL.canonical({ b: 1, a: [2, { d: 3, c: 4 }] }),
  canonical({ a: [2, { c: 4, d: 3 }], b: 1 })
);
eq('canonical 跳过 undefined', ZL.canonical({ a: 1, b: undefined }), '{"a":1}');
eq('canonical 保持数组顺序', ZL.canonical([3, 1, 2]), '[3,1,2]');
eq('sha256 与页面实现一致', await ZL.sha256Hex('zenith'), await sha256Hex('zenith'));
eq(
  'sha256 已知向量',
  await sha256Hex('abc'),
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
);
eq(
  'basicAuth 支持中文凭据',
  ZL.basicAuth('用户', '密码'),
  'Basic ' + Buffer.from('用户:密码', 'utf8').toString('base64')
);
eq(
  'joinUrl 不重复斜杠',
  ZL.joinUrl('https://a.com/dav/', '/zenith/config.json'),
  'https://a.com/dav/zenith/config.json'
);
eq('etag 去掉引号与 W/', ZL.normalizeEtag('W/"abc"'), 'abc');
eq('originOf 生成权限匹配串', ZL.originOf('https://dav.a.com/x/y'), 'https://dav.a.com/*');

const cfg = configOf({
  v: 2,
  theme: { mode: 'auto' },
  ui: { scale: 1 },
  wallpaper: { type: 'image', preset: 'ink', dim: 0, imageKey: 'w' },
  engine: 'bing',
  items: [],
  widgetData: {},
  links: [],
  groups: []
});
ok('configOf 带 app 标记（供校验来源）', cfg.app === 'zenith');
ok('configOf 不含 links/groups', !('links' in cfg) && !('groups' in cfg));
eq('configOf 清空壁纸图片引用', cfg.wallpaper.imageKey, null);

/* ---------- 同步节流：手动触发不能被间隔拦住 ---------- */
const T = Date.UTC(2026, 9, 30, 12, 0, 0);
const day = 1440 * 60000;

eq('auto：刚同步过 → 跳过', shouldSkip({ lastAt: T - 60000 }, { intervalMin: 1440 }, T, 'auto'), true);
eq('auto：超过间隔 → 执行', shouldSkip({ lastAt: T - day - 60000 }, { intervalMin: 1440 }, T, 'auto'), false);
eq('auto：从未同步过 → 执行', shouldSkip({ lastAt: 0 }, { intervalMin: 1440 }, T, 'auto'), false);
eq('手动 now：刚同步过也执行', shouldSkip({ lastAt: T - 1000 }, { intervalMin: 1440 }, T, 'now'), false);
eq('失败后 5 分钟内不重试', shouldSkip({ lastAt: T - 120000, failed: true }, { intervalMin: 1440 }, T, 'auto'), true);
eq(
  '失败后超过 5 分钟重试',
  shouldSkip({ lastAt: T - FAIL_BACKOFF - 1000, failed: true }, { intervalMin: 1440 }, T, 'auto'),
  false
);
eq('间隔填太小也按下限 15 分钟算', shouldSkip({ lastAt: T - 5 * 60000 }, { intervalMin: 1 }, T, 'auto'), true);

/* ---------- 412 后判断内容是否其实一致 ---------- */

eq('同内容不同键序算相等', sameContent('{\"a\":1,\"b\":2}', '{\n  \"b\": 2,\n  \"a\": 1\n}'), true);
eq('内容不同算不等', sameContent('{\"a\":1}', '{\"a\":2}'), false);
eq('远端不是 JSON 时判不等', sameContent('not json', '{}'), false);

/* ---------- 自定义图标：格式嗅探 / 透明检测 / 白边裁切 ---------- */

const pngMagic = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
eq('PNG 魔数识别', sniffImageMime(pngMagic, ''), 'image/png');
eq(
  'JPEG 魔数识别',
  sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]), 'a'),
  'image/jpeg'
);
eq(
  'WebP 魔数识别',
  sniffImageMime(
    new Uint8Array([...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBP')]),
    ''
  ),
  'image/webp'
);
eq(
  'ICO 魔数识别',
  sniffImageMime(new Uint8Array([0, 0, 1, 0, 1, 0]), ''),
  'image/x-icon'
);
eq(
  'SVG 靠文本标记识别',
  sniffImageMime(new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="..."></svg>'), ''),
  'image/svg+xml'
);
eq('扩展名兜底', sniffImageMime(new Uint8Array([1, 2, 3, 4]), 'photo.SVG'), 'image/svg+xml');
eq('完全认不出返回 null', sniffImageMime(new Uint8Array([1, 2, 3, 4]), 'x.bin'), null);

/* 16×16 的测试图工具 */
function makeImg(w, h, paint) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const [r, g, b, a] = paint(p % w, Math.floor(p / w));
    d[p * 4] = r;
    d[p * 4 + 1] = g;
    d[p * 4 + 2] = b;
    d[p * 4 + 3] = a;
  }
  return d;
}

eq('全不透明没有透明通道', hasAlphaChannel(makeImg(8, 8, () => [255, 0, 0, 255]), 8, 8), false);
eq(
  '任一像素透明就算透明',
  hasAlphaChannel(makeImg(8, 8, (x) => [255, 0, 0, x === 0 ? 128 : 255]), 8, 8),
  true
);

/* 白底 + 中央红块：白边应被清掉，红块完好 */
{
  const d = makeImg(16, 16, (x, y) => {
    const inRed = x >= 5 && x <= 10 && y >= 5 && y <= 10;
    return inRed ? [200, 30, 30, 255] : [255, 255, 255, 255];
  });
  ok('判定通过（白底板形态）', stripBackdropPixels(d, 16, 16) === true);
  ok('白底被清掉一大部分', d[3] === 0);
  eq('红块中心还在', d[(8 * 16 + 8) * 4 + 3], 255);
  eq('红块颜色未动', d[(8 * 16 + 8) * 4], 200);
}

/* 透明边距 + 白色圆角方块：网易云那类的真实形态。
   旧版只从画布字面边缘找白，被透明边距挡住就放弃了——这是「去白底无效」的根因。 */
{
  const d = makeImg(24, 24, (x, y) => {
    const inSquare = x >= 4 && x <= 19 && y >= 4 && y <= 19;
    if (!inSquare) return [0, 0, 0, 0]; /* 四周 4px 透明边距 */
    const inRed = x >= 8 && x <= 15 && y >= 8 && y <= 15;
    return inRed ? [230, 0, 38, 255] : [255, 255, 255, 255];
  });
  ok('透明边距不挡住判定', stripBackdropPixels(d, 24, 24) === true);
  eq('方块边缘的白被清掉', d[(4 * 24 + 6) * 4 + 3], 0);
  eq('红圆中心完好', d[(12 * 24 + 12) * 4 + 3], 255);
}

/* 白 logo 在透明底上：泛洪会穿过透明区到达它，但「裁完几乎不剩」的闸会拦住 */
{
  const d = makeImg(16, 16, (x, y) => {
    const inLogo = x >= 6 && x <= 9 && y >= 6 && y <= 9;
    return inLogo ? [255, 255, 255, 255] : [0, 0, 0, 0];
  });
  eq('整只白 logo 被判定放弃（保持原图）', stripBackdropPixels(d, 16, 16), false);
  eq('白 logo 完好', d[(7 * 16 + 7) * 4 + 3], 255);
}

/* 细笔画白 logo：包围盒大部分透明，内容占比闸直接放行不做处理 */
{
  const d = makeImg(16, 16, (x, y) => {
    const inStroke = y >= 4 && y <= 6 && x >= 2 && x <= 13;
    return inStroke ? [255, 255, 255, 255] : [0, 0, 0, 0];
  });
  eq('细笔画白标不做白底处理', stripBackdropPixels(d, 16, 16), false);
}

/* 白色横条触边：泛洪会裁，但剩余比例归零 → 放弃 */
{
  const d = makeImg(16, 16, (x, y) => {
    const inBar = y >= 7 && y <= 8;
    return inBar ? [255, 255, 255, 255] : [0, 0, 0, 0];
  });
  eq('贴边白条整体放弃', stripBackdropPixels(d, 16, 16), false);
}

/* 纯色透明图标（没有白）：不该有任何改动 */
{
  const d = makeImg(16, 16, (x, y) => {
    const inDot = x >= 5 && x <= 10 && y >= 5 && y <= 10;
    return inDot ? [30, 120, 220, 255] : [0, 0, 0, 0];
  });
  eq('无白的透明图标保持原样', stripBackdropPixels(d, 16, 16), false);
}

eq('尺寸太小直接跳过', trimWhiteEdges(new Uint8ClampedArray(2 * 2 * 4), 2, 2), 0);

/* ---------- 首帧防闪：boot.js 的同步副作用 ---------- */

/* boot.js 是 <head> 里的经典脚本，没有模块导出；用 vm 沙箱跑一遍源码，
   断言它对 <html> 做的同步设置（防闪的全部意义就在「首帧前定下来」）。 */
function runBoot(env) {
  const sandbox = {
    performance: { now: () => 0 },
    localStorage: {
      store: env.ls || {},
      getItem(k) {
        return this.store[k] ?? null;
      },
      setItem(k, v) {
        this.store[k] = String(v);
      },
      removeItem(k) {
        delete this.store[k];
      }
    },
    document: {
      documentElement: {
        attrs: {},
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
        removeAttribute(k) {
          delete this.attrs[k];
        },
        style: {
          props: {},
          setProperty(k, v) {
            this.props[k] = v;
          },
          backgroundColor: '',
          backgroundImage: '',
          backgroundSize: '',
          backgroundPosition: ''
        }
      }
    },
    matchMedia: () => ({ matches: !!env.prefersDark }),
    window: {}
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(SRC_ROOT, 'js', 'boot.js'), 'utf8'), sandbox, { filename: 'boot.js' });
  return { root: sandbox.document.documentElement, boot: sandbox.window.__ZL_BOOT };
}

const IMG_SHOT = 'data:image/webp;base64,AAAA';

{
  const { root } = runBoot({
    ls: {
      'zl.state': JSON.stringify({
        theme: { mode: 'dark' },
        wallpaper: { type: 'image', preset: 'aurora', dim: 0, imageDim: 0.35, adaptDim: 0.15, imageKey: 'k1' }
      }),
      'zl.wallpaper.shot': IMG_SHOT,
      'zl.adapt': JSON.stringify({ key: 'k1|48000|image/avif', tone: 'light' })
    }
  });
  eq('深色主题的打底色', root.style.backgroundColor, '#16181c');
  ok('壁纸缓存首帧上屏', String(root.style.backgroundImage).includes(IMG_SHOT));
  eq('首帧已有自动配色结论', root.attrs['data-adapt'], 'light');
  eq('data-wall 首帧就是 image', root.attrs['data-wall'], 'image');
}

{
  const { root } = runBoot({
    ls: {
      'zl.state': JSON.stringify({
        theme: { mode: 'light' },
        wallpaper: { type: 'image', imageKey: 'k2' }
      }),
      'zl.wallpaper.shot': IMG_SHOT,
      /* 缓存的 key 是另一张图的：不能套用 */
      'zl.adapt': JSON.stringify({ key: 'k1|48000|image/avif', tone: 'light' })
    }
  });
  eq('浅色主题的打底色', root.style.backgroundColor, '#f4f3ef');
  eq('换过壁纸后旧配色结论不套用', root.attrs['data-adapt'], undefined);
}

{
  const { root } = runBoot({
    ls: {
      'zl.state': JSON.stringify({ theme: { mode: 'dark' }, wallpaper: { type: 'preset', preset: 'aurora' } })
    }
  });
  eq('预设壁纸不铺缓存图', root.style.backgroundImage, '');
  eq('跟随系统深色的打底色', root.style.backgroundColor, '#16181c');
  eq('data-wall 是 preset', root.attrs['data-wall'], 'preset');
}

{
  const { root } = runBoot({
    prefersDark: true,
    ls: { 'zl.state': JSON.stringify({ theme: { mode: 'auto' }, wallpaper: { type: 'preset' } }) }
  });
  eq('跟随系统（系统深色）打底也深', root.style.backgroundColor, '#16181c');
  eq('auto 模式不写死 data-theme', root.attrs['data-theme'], undefined);
}

{
  const { root } = runBoot({
    prefersDark: true,
    ls: {
      'zl.state': JSON.stringify({
        theme: { mode: 'auto' },
        wallpaper: { type: 'image', imageKey: 'k9' }
      }),
      'zl.wallpaper.shot': IMG_SHOT,
      /* 浏览器深色 + 浅色壁纸：打底色跟壁纸的均色走，不跟系统 */
      'zl.wallpaper.avg': '214,236,255',
      'zl.wallpaper.tone': 'light'
    }
  });
  eq('深色系统 + 亮壁纸：打底跟壁纸均色', root.style.backgroundColor, 'rgb(214,236,255)');
  eq('粗采样方向也提前应用', root.attrs['data-adapt'], 'light');
}

{
  const { root } = runBoot({
    prefersDark: true,
    ls: {
      'zl.state': JSON.stringify({ theme: { mode: 'auto' }, wallpaper: { type: 'image', imageKey: 'k9' } }),
      /* 没有均色（老数据）但有方向：用中性亮色兜底 */
      'zl.wallpaper.tone': 'light'
    }
  });
  eq('无均色时按方向兜底（亮）', root.style.backgroundColor, '#eef0f2');
}

{
  const { root } = runBoot({
    prefersDark: true,
    ls: {
      'zl.state': JSON.stringify({ theme: { mode: 'auto' }, wallpaper: { type: 'image', imageKey: 'k1' } }),
      'zl.wallpaper.avg': '20,24,30',
      'zl.wallpaper.tone': 'dark',
      /* 正式采样结论存在且 key 匹配：优先于粗采样 */
      'zl.adapt': JSON.stringify({ key: 'k1|48000|image/avif', tone: 'light' })
    }
  });
  eq('均色优先', root.style.backgroundColor, 'rgb(20,24,30)');
  eq('正式采样结论优先于粗采样', root.attrs['data-adapt'], 'light');
}

{
  const { root } = runBoot({
    prefersDark: true,
    ls: { 'zl.state': JSON.stringify({ theme: { mode: 'auto' }, wallpaper: { type: 'preset' } }) }
  });
  eq('预设壁纸仍跟浏览器主题', root.style.backgroundColor, '#16181c');
}

/* ---------- 同步：图标随 WebDAV 走，GitHub 不带 ---------- */

{
  const state = {
    v: 2,
    theme: { mode: 'auto' },
    ui: {},
    wallpaper: { type: 'image', preset: 'aurora', dim: 0, imageDim: 0.35, adaptDim: 0.15, imageKey: 'k1' },
    engine: 'bing',
    items: [
      { id: 'a', kind: 'link', title: 'A', url: 'https://a.com', cols: 1, rows: 1, icon: 'data:image/png;base64,AAA' },
      { id: 'b', kind: 'link', title: 'B', url: 'https://b.com', cols: 1, rows: 1 }
    ],
    widgetData: {}
  };
  const stripped = withoutIcons(configOf(state));
  eq('GitHub 配置剥掉 icon', stripped.items[0].icon, undefined);
  eq('其它字段保留', stripped.items[0].url, 'https://a.com');
  eq('壁纸 imageKey 仍然清空', stripped.wallpaper.imageKey, null);
  eq('WebDAV 配置带 icon', configOf(state).items[0].icon, 'data:image/png;base64,AAA');

  const webdavText = buildSyncText(state, 'webdav');
  const ghText = buildSyncText(state, 'github');
  eq('WebDAV 文本含图标数据', webdavText.includes('data:image/png'), true);
  eq('GitHub 文本不含图标数据', ghText.includes('data:image'), false);
}

/* ---------- 自动配色：按背景亮度选深/浅文字 ---------- */

eq('纯黑背景用浅色文字', pickTone(0), 'dark');
eq('纯白背景用深色文字', pickTone(1), 'light');
eq('暗背景（L=0.1）用浅色文字', pickTone(0.1), 'dark');
eq('亮背景（L=0.3）用深色文字', pickTone(0.3), 'light');
eq('分界附近偏暗侧仍是浅色文字', pickTone(0.17), 'dark');
eq('分界附近偏亮侧是深色文字', pickTone(0.19), 'light');
eq('越界值钳到 0..1', pickTone(2), 'light');
eq('非法值当作 0', pickTone(NaN), 'dark');

/* ---------- 壁纸遮罩：预设与照片各记一个强度 ---------- */

const WPD = { dim: 0, imageDim: 0.5 };
eq('旧数据缺 imageDim 时补默认 50%', normalizeWallpaper({ dim: 0.2 }, WPD).imageDim, 0.5);
eq('旧数据自带的 dim 保留', normalizeWallpaper({ dim: 0.2 }, WPD).dim, 0.2);
eq('遮罩上限钳到 0.8', normalizeWallpaper({ dim: 2, imageDim: 5 }, WPD).imageDim, 0.8);
eq('遮罩下限钳到 0', normalizeWallpaper({ dim: -1, imageDim: -3 }, WPD).dim, 0);
eq('非数字回落默认值', normalizeWallpaper({ dim: 'x', imageDim: null }, WPD).imageDim, 0.5);

/* ---------- 构建产物守卫 ---------- */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs, base));
    else out.push(relative(base, abs).split('\\').join('/'));
  }
  return out;
}

if (existsSync(DIST)) {
  const ALWAYS = [/eval\s*\(/, /new\s+Function/];
  const NET = [/fetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/];
  /* 只有后台的两个文件允许发请求，页面侧一个都不许有 */
  const BG_FILES = new Set(['sync-core.js', 'background.js']);
  const files = walk(DIST).filter((f) => /\.(js|html)$/.test(f));
  const hits = [];
  for (const f of files) {
    const rel = f.split('/').slice(1).join('/');
    const text = readFileSync(join(DIST, f), 'utf8');
    const checks = BG_FILES.has(rel) ? ALWAYS : ALWAYS.concat(NET);
    for (const re of checks) if (re.test(text)) hits.push(`${f} → ${re}`);
  }
  eq('页面侧无联网 API、全树无 eval', hits.length, 0);

  for (const target of ['chrome', 'firefox']) {
    const mfPath = join(DIST, target, 'manifest.json');
    if (!existsSync(mfPath)) {
      ok(`${target} manifest 存在`, false);
      continue;
    }
    const mf = JSON.parse(readFileSync(mfPath, 'utf8'));
    const csp = mf.content_security_policy.extension_pages;
    ok(`${target} CSP 只允许本地脚本`, csp.includes("script-src 'self'"));
    ok(`${target} CSP 允许后台联网（不能是 none）`, /connect-src (?!'none')/.test(csp), csp);
    ok(`${target} 覆盖新标签页`, mf.chrome_url_overrides.newtab === 'newtab.html');
    const perms = [...(mf.permissions || []), ...(mf.optional_permissions || [])];
    ok(`${target} 无 <all_urls>`, !perms.includes('<all_urls>'));
    ok(`${target} 无 history/cookies`, !perms.includes('history') && !perms.includes('cookies'));
    if (target === 'chrome') {
      ok('chrome 未申请 tabs', !perms.includes('tabs'));
      ok('chrome 申请了 favicon', perms.includes('favicon'));
    }
    if (target === 'firefox') {
      ok('firefox 的 tabs 是可选权限', (mf.optional_permissions || []).includes('tabs'));
      ok('firefox 有后台脚本', Array.isArray(mf.background?.scripts));
    }
  }
} else {
  console.log('（未找到 dist/，跳过产物守卫；先运行 node build.mjs）');
}

/* ---------- 汇总 ---------- */
console.log(`\n通过 ${pass} 项`);
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ 全部通过');
