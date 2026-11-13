/* 人民币金额转大写：分组处理「万/亿」，尾部按角分补「整」。 */
import { el } from '../util.js';

const DIGIT = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
const SMALL = ['', '拾', '佰', '仟'];
const BIG = ['', '万', '亿', '万亿'];

function section(num) {
  let str = '';
  let zero = false;
  for (let i = 3; i >= 0; i--) {
    const d = Math.floor(num / Math.pow(10, i)) % 10;
    if (d === 0) {
      zero = true;
    } else {
      if (zero && str) str += '零';
      zero = false;
      str += DIGIT[d] + SMALL[i];
    }
  }
  return str;
}

export function toChineseAmount(input) {
  const raw = Number(input);
  if (!Number.isFinite(raw)) return '';
  if (Math.abs(raw) > 9999999999999.99) return '数值过大';

  const neg = raw < 0;
  const abs = Math.round(Math.abs(raw) * 100) / 100;
  const fixed = abs.toFixed(2);
  const [intStr, decStr] = fixed.split('.');
  const intNum = Number(intStr);

  let intPart = '';
  if (intNum === 0) {
    intPart = '零';
  } else {
    const groups = [];
    let rest = intNum;
    while (rest > 0) {
      groups.push(rest % 10000);
      rest = Math.floor(rest / 10000);
    }
    for (let g = groups.length - 1; g >= 0; g--) {
      const part = section(groups[g]);
      if (!part) {
        if (intPart && !intPart.endsWith('零')) intPart += '零';
        continue;
      }
      /* 组内不足四位且前面已有数字时，需要补「零」，例如 10001 → 壹万零壹 */
      if (intPart && groups[g] < 1000 && !intPart.endsWith('零')) intPart += '零';
      intPart += part + BIG[g];
    }
    intPart = intPart.replace(/零+$/, '');
  }

  let tail = '';
  const jiao = Number(decStr[0]);
  const fen = Number(decStr[1]);
  if (jiao === 0 && fen === 0) {
    tail = '整';
  } else {
    if (jiao > 0) tail += DIGIT[jiao] + '角';
    if (fen > 0) {
      if (jiao === 0 && intNum > 0) tail += '零';
      tail += DIGIT[fen] + '分';
    }
  }

  return (neg ? '负' : '') + intPart + '元' + tail;
}

export default {
  type: 'money',
  name: '大写金额',
  cols: 2,
  rows: 1,

  mount(body, ctx) {
    const data = ctx.data({ value: '' });
    const input = el('input', {
      class: 'w-input',
      placeholder: '输入金额，如 1234.56',
      value: data.value || ''
    });
    const out = el('div', { class: 'w-result money', text: '' });

    function run() {
      data.value = input.value;
      out.textContent = toChineseAmount(input.value) || '—';
      ctx.save();
    }

    input.addEventListener('input', run);
    body.append(input, out);
    if (data.value) out.textContent = toChineseAmount(data.value) || '—';
  }
};
