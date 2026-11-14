/* ===========================================================
   导入：把文件解析成书籍记录
   =========================================================== */

import { loadEpub, splitTxt } from './epub-parse.js';
import { makeCover, fallbackCover, uid, naturalCompare, fmtBytes } from './util.js';
import { seriesInfo, makeBook } from './parts.js';

export const MAX_BOOKS = 5000;
export const MAX_FILE_SIZE = 400 * 1024 * 1024;
const IMG_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;

export const TYPE_LABEL = {
  comic: '漫画',
  epub: '小说',
  txt: '文本',
  pdf: 'PDF',
};

export function detectType(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['cbz', 'cbr', 'zip'].includes(ext)) return { type: 'comic', ext };
  if (ext === 'epub') return { type: 'epub', ext };
  if (['txt', 'md', 'markdown'].includes(ext)) return { type: 'txt', ext };
  if (ext === 'pdf') return { type: 'pdf', ext };
  return null;
}

export function baseName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
}

export function comicEntries(zip) {
  return Object.keys(zip.files)
    .filter((path) => {
      const f = zip.files[path];
      if (!f || f.dir) return false;
      if (!IMG_RE.test(path)) return false;
      if (path.startsWith('__MACOSX/')) return false;
      if (/(^|\/)\.[^/]*$/.test(path)) return false;
      if (/(^|\/)thumb(nail)?s?\//i.test(path)) return false;
      return true;
    })
    .sort(naturalCompare);
}

async function epubBook(file) {
  const zip = await JSZip.loadAsync(file);
  const parsed = await loadEpub(zip);
  const title = parsed.meta.title || baseName(file.name);
  let cover = null;
  let coverEntry = parsed.coverHref ? zip.file(parsed.coverHref) : null;
  if (!coverEntry) {
    // 有些 EPUB 的封面没进 manifest，退一步找文件名里带 cover 的图片
    const guess = Object.keys(zip.files).find((p) => /(^|\/)cover[^/]*\.(jpe?g|png|webp|gif)$/i.test(p));
    if (guess) coverEntry = zip.file(guess);
  }
  if (coverEntry) cover = await makeCover(await coverEntry.async('blob'));

  return {
    type: 'epub',
    title,
    author: parsed.meta.creator || '',
    cover: cover || fallbackCover(title, 'EPUB'),
    coverDerived: !cover,
    count: parsed.spine.length,
    countLabel: `${parsed.spine.length} 章`,
  };
}

async function comicBook(file) {
  let zip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    const isRar = /\.cbr$/i.test(file.name);
    throw new Error(isRar ? 'CBR 是 RAR 压缩，暂不支持，请先转成 CBZ' : '压缩包损坏或不是 ZIP 格式');
  }
  const entries = comicEntries(zip);
  if (!entries.length) throw new Error('压缩包里没有找到图片');
  const title = baseName(file.name);
  const first = zip.file(entries[0]);
  const cover = first ? await makeCover(await first.async('blob')) : null;
  return {
    type: 'comic',
    title,
    author: '',
    cover: cover || fallbackCover(title, 'CBZ'),
    coverDerived: !cover,
    count: entries.length,
    countLabel: `${entries.length} 页`,
  };
}

async function txtBook(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error('文本文件过大（上限 20MB）');
  const text = await file.text();
  const chapters = splitTxt(text);
  const title = baseName(file.name);
  return {
    type: 'txt',
    title,
    author: '',
    cover: fallbackCover(title, 'TXT'),
    coverDerived: true,
    count: chapters.length,
    countLabel: `${chapters.length} 章`,
    extra: { chars: text.length },
  };
}

function pdfBook(file) {
  const title = baseName(file.name);
  return {
    type: 'pdf',
    title,
    author: '',
    cover: fallbackCover(title, 'PDF'),
    coverDerived: true,
    count: 0,
    countLabel: `${fmtBytes(file.size)}`,
  };
}

/**
 * 解析单个文件，返回「分段」信息（不含持久化）
 * 分段可以单独成书，也可以和同系列的分段合成一本书
 * @param {File} file
 */
export async function parsePart(file) {
  if (!file || !file.size) throw new Error('空文件');
  if (file.size > MAX_FILE_SIZE) throw new Error(`文件超过 ${fmtBytes(MAX_FILE_SIZE)}`);
  const kind = detectType(file.name);
  if (!kind) throw new Error('不支持的格式');

  let info;
  if (kind.type === 'comic') info = await comicBook(file);
  else if (kind.type === 'epub') info = await epubBook(file);
  else if (kind.type === 'txt') info = await txtBook(file);
  else info = pdfBook(file);

  const series = seriesInfo(file.name);
  return {
    id: uid(),
    name: file.name,
    ext: kind.ext,
    size: file.size,
    order: series.order,
    seriesKey: series.key,
    seriesBase: series.base,
    seriesHasBase: series.hasBase,
    grouped: series.grouped,
    ...info,
  };
}

/**
 * 解析单个文件为一本独立的书（单分段），保留给只需要「一文件一书」的调用方
 * @param {File} file
 */
export async function parseBookFile(file) {
  const part = await parsePart(file);
  return makeBook([part], {
    type: part.type,
    title: part.title,
    author: part.author,
    cover: part.cover,
    series: part.grouped ? { key: part.seriesKey, base: part.seriesBase } : null,
  });
}

/* ===========================================================
   目录导入：文件已由原生写进 books/，这里只补元数据
   页数与封面都从原生拿到，不再把整个压缩包读进 JS
   =========================================================== */

/**
 * @param {{id:string,name:string,size:number,pages:number,cover?:string|null}} meta
 */
export function stagedComicPart({ id, name, size, pages, cover }) {
  const title = baseName(name);
  const series = seriesInfo(name);
  return {
    id,
    name,
    ext: 'cbz',
    size,
    type: 'comic',
    title,
    author: '',
    cover: cover || fallbackCover(title, 'CBZ'),
    coverDerived: !cover,
    count: pages,
    countLabel: `${pages} 页`,
    order: series.order,
    seriesKey: series.key,
    seriesBase: series.base,
    seriesHasBase: series.hasBase,
    grouped: series.grouped,
  };
}

/** PDF 不解析页数，只记体积（与 pdfBook 一致） */
export function stagedPdfPart({ id, name, size }) {
  const title = baseName(name);
  const series = seriesInfo(name);
  return {
    id,
    name,
    ext: 'pdf',
    size,
    type: 'pdf',
    title,
    author: '',
    cover: fallbackCover(title, 'PDF'),
    coverDerived: true,
    count: 0,
    countLabel: `${fmtBytes(size)}`,
    order: series.order,
    seriesKey: series.key,
    seriesBase: series.base,
    seriesHasBase: series.hasBase,
    grouped: series.grouped,
  };
}
