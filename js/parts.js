/* ===========================================================
   多分段：一本书可以由多个文件（卷 / 章 / 分册）组成
   - seriesInfo   从文件名识别「第几卷 / 第几章」，用于归并
   - bookParts    取书的分段列表（兼容早期一本一文件的数据）
   - recalcBook   按分段重算体量、大小与计数文案
   =========================================================== */

import { naturalCompare, fmtBytes, uid } from './util.js';

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 };
const UP_MID_DOWN = { 上: 1, 中: 2, 下: 3 };

/** 中文数字转阿拉伯数字：十二 -> 12，二十一 -> 21 */
export function cnNumber(str) {
  if (!str) return NaN;
  if (/^\d+$/.test(str)) return Number(str);
  let section = 0;
  let num = 0;
  let seen = false;
  for (const ch of str) {
    if (CN_DIGITS[ch] != null) {
      num = CN_DIGITS[ch];
      seen = true;
    } else if (CN_UNITS[ch]) {
      section += (num || 1) * CN_UNITS[ch];
      num = 0;
      seen = true;
    } else {
      return NaN;
    }
  }
  return seen ? section + num : NaN;
}

/** 4 位年份不当作卷号，避免「夜航（2019）」被误判成第一册 */
const isYear = (n) => n >= 1900 && n <= 2099;

const SEP = '[\\s_.·\\-—,，、]';

/** 依次匹配各种「卷 / 章 / 册」写法，命中的片段从主干里剔除 */
const MARKS = [
  { re: /第\s*([0-9零〇一二三四五六七八九十百千两]{1,8})\s*[卷部册集篇章回节话]/g, kind: 'cn' },
  { re: new RegExp(`(?:^|${SEP})(?:chapter|chap|ch|episode|ep)\\.?\\s*(\\d{1,4})(?=$|${SEP})`, 'gi'), kind: 'num' },
  { re: new RegExp(`(?:^|${SEP})(?:vol(?:ume)?|v)\\.?\\s*(\\d{1,4})(?=$|${SEP})`, 'gi'), kind: 'num' },
  { re: /[\[【(（]\s*([0-9零〇一二三四五六七八九十百千两]{1,8})\s*[\]】)）]/g, kind: 'cn' },
  { re: /(?:^|[\s_.·\-—第])([上中下])\s*册?$/g, kind: 'updown' },
  { re: new RegExp(`(?:^|${SEP})(\\d{1,4})(?=$|${SEP})`, 'g'), kind: 'num' },
  { re: /(\d{1,4})\s*$/g, kind: 'num' },
];

/**
 * 解析文件名里的「系列」信息
 * @param {string} rawName 文件名或书名
 * @returns {{key: string, base: string, order: number[], grouped: boolean}}
 *   key   用于判定同属一本书的规范化主干
 *   order 依次出现的卷/章序号，用于排序
 */
export function seriesInfo(rawName) {
  const clean = String(rawName || '')
    .replace(/\.[^.]+$/, '')
    .replace(/_+/g, ' ')
    .trim();

  const order = [];
  let rest = clean;

  for (const { re, kind } of MARKS) {
    re.lastIndex = 0;
    rest = rest.replace(re, (full, g1) => {
      let n = NaN;
      if (kind === 'num') n = Number(g1);
      else if (kind === 'cn') n = cnNumber(g1);
      else n = UP_MID_DOWN[g1];
      if (!Number.isFinite(n) || isYear(n)) return full;
      order.push(n);
      return ' ';
    });
  }

  let base = rest
    .replace(/[\[【(（\]】)）]/g, ' ')
    .replace(/^[\s_.·\-—,，、]+/, '')
    .replace(/[\s_.·\-—,，、]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  base = base.replace(/^第\s*/, '').trim();

  const hasBase = base.length > 0;
  const key = base.toLowerCase().replace(/[\s_.·\-—,，、:：]/g, '');
  return {
    key: key || clean.toLowerCase(),
    base: base || clean,
    order,
    hasBase,
    grouped: hasBase && order.length > 0,
  };
}

/**
 * 正式书名：剥掉「第X话 / 第X卷 / (3)」这类占位编号，只留系列主干。
 * 合并成一本或从文件名起书名时用，避免出现「xxxx 第一话」这种名字。
 * 没识别到编号（或只是年份）时原样返回，不会误伤《1984》《夜航（2019）》。
 */
export function formalTitle(raw) {
  const clean = String(raw || '').trim();
  if (!clean) return clean;
  const si = seriesInfo(clean);
  return si.grouped && si.base ? si.base : clean;
}

/* ---------------- 分段 ---------------- */

/** 一段（一个文件）在书里的位置：先比卷号序列，再按文件名自然排序 */
export function compareParts(a, b) {
  const A = Array.isArray(a?.order) ? a.order : [];
  const B = Array.isArray(b?.order) ? b.order : [];
  // 没有卷号的（整本导入、或手动并入的散本）排在带卷号的后面
  if (!A.length && !B.length) return naturalCompare(a?.name || '', b?.name || '');
  if (!A.length) return 1;
  if (!B.length) return -1;
  const len = Math.max(A.length, B.length);
  for (let i = 0; i < len; i++) {
    if (A[i] == null) return -1;
    if (B[i] == null) return 1;
    if (A[i] !== B[i]) return A[i] - B[i];
  }
  return naturalCompare(a?.name || '', b?.name || '');
}

export function sortParts(list) {
  return list.slice().sort(compareParts);
}

export function partKey(part) {
  return `${part?.name || ''}|${part?.size || 0}`;
}

/** 只保留可序列化字段，避免把 File / JSZip 写进 IndexedDB */
export function cleanPart(part) {
  return {
    id: part.id,
    name: part.name || '',
    size: part.size || 0,
    ext: part.ext || '',
    type: part.type || '',
    count: part.count || 0,
    countLabel: part.countLabel || '',
    order: Array.isArray(part.order) ? part.order.slice() : [],
  };
}

/**
 * 取书的分段列表；早期数据没有 parts 字段，退化成「书名.ext 一个文件」
 */
export function bookParts(book) {
  if (!book) return [];
  if (Array.isArray(book.parts) && book.parts.length) return book.parts;
  return [{
    id: book.id,
    name: book.name || `${book.title || '未命名'}.${book.ext || 'bin'}`,
    size: book.size || 0,
    ext: book.ext || '',
    type: book.type || '',
    count: book.count || 0,
    countLabel: book.countLabel || '',
    order: [],
    legacy: true,
  }];
}

export function partLabel(index) {
  return `第 ${index + 1} 册`;
}

/** 合并后每个分段就是一个「章」（漫画）或「册」（文字），详情与结果页统一用它取标题 */
export function partUnit(book) {
  return book?.type === 'comic' ? '章' : '册';
}

/**
 * 分段在书里的章节名：第 3 章 · 海底
 * 文件名主干和书名一样时（海贼王 第03卷.cbz / 海贼王）只留序号，避免重复
 */
export function partChapterLabel(part, index, book) {
  const raw = String(part?.name || '').replace(/\.[^.]+$/, '');
  const { base, hasBase } = seriesInfo(raw);
  const title = String(book?.title || '').trim().toLowerCase();
  const showBase = hasBase && base && base.trim().toLowerCase() !== title;
  return `第 ${index + 1} ${partUnit(book)}${showBase ? ` · ${base.trim()}` : ''}`;
}

/** 按分段重算体量：章数 / 页数求和，体积求和 */
export function recalcBook(book) {
  const parts = sortParts(bookParts(book).map(cleanPart));
  book.parts = parts;
  book.size = parts.reduce((sum, p) => sum + (p.size || 0), 0);
  book.count = parts.reduce((sum, p) => sum + (p.count || 0), 0);
  book.ext = book.ext || parts[0]?.ext || '';

  if (book.type === 'comic') book.countLabel = `${book.count} 页`;
  else if (book.type === 'pdf') book.countLabel = fmtBytes(book.size);
  else book.countLabel = `${book.count} 章`;

  return book;
}

/**
 * 由若干分段组装一本新书
 * @param {Array} parts parsePart 的返回值
 * @param {Object} extra 覆盖字段（title / type / series …）
 */
export function makeBook(parts, extra = {}) {
  const list = sortParts(parts.map(cleanPart));
  const first = list[0] || {};
  const book = {
    id: extra.id || uid(),
    type: extra.type || first.type || 'txt',
    title: extra.title || first.title || String(first.name || '').replace(/\.[^.]+$/, '') || '未命名',
    author: extra.author != null ? extra.author : (first.author || ''),
    cover: extra.cover || first.cover || '',
    coverDerived: extra.coverDerived != null ? extra.coverDerived : !!first.coverDerived,
    ext: first.ext || '',
    series: extra.series || null,
    parts: list,
    addedAt: Date.now(),
    progress: 0,
    loc: null,
    lastReadAt: 0,
    finished: false,
    isNew: true,
    ...extra,
  };
  if (!book.type) book.type = first.type || 'txt';
  return recalcBook(book);
}
