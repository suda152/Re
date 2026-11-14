/* ===========================================================
   EPUB / TXT 解析（导入与阅读器共用）
   =========================================================== */

export function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

export function joinPath(baseDir, rel) {
  if (!rel) return baseDir;
  let r = rel.split('#')[0];
  try { r = decodeURIComponent(r); } catch { /* keep raw */ }
  if (r.startsWith('/')) return r.replace(/^\/+/, '');
  const parts = (baseDir + r).split('/');
  const out = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

/** 在 zip 里按路径取文件，容忍编码与大小写差异 */
export function zipFile(zip, path) {
  if (!path) return null;
  const direct = zip.file(path);
  if (direct) return direct;
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { /* ignore */ }
  if (decoded !== path) {
    const f = zip.file(decoded);
    if (f) return f;
  }
  const lower = path.toLowerCase();
  const key = Object.keys(zip.files).find((k) => k.toLowerCase() === lower);
  return key ? zip.file(key) : null;
}

function parseXml(text, type = 'application/xml') {
  const doc = new DOMParser().parseFromString(text, type);
  if (doc.querySelector('parsererror')) throw new Error('XML 解析失败');
  return doc;
}

/** 按限定名取元数据（避免 XML 命名空间选择器的兼容问题） */
function metaText(scope, names) {
  if (!scope) return '';
  for (const name of names) {
    const el = scope.getElementsByTagName(name)[0];
    const v = el?.textContent?.trim();
    if (v) return v;
  }
  return '';
}

/**
 * @param {JSZip} zip
 * @returns {Promise<{meta, spine, manifest, toc, opfPath, opfDir, coverHref}>}
 */
export async function loadEpub(zip) {
  const containerFile = zipFile(zip, 'META-INF/container.xml');
  if (!containerFile) throw new Error('不是有效的 EPUB：缺少 container.xml');
  const container = parseXml(await containerFile.async('string'));
  const rootPath = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!rootPath) throw new Error('不是有效的 EPUB：缺少 rootfile');

  const opfFile = zipFile(zip, rootPath);
  if (!opfFile) throw new Error('EPUB 结构损坏：找不到 OPF');
  const opf = parseXml(await opfFile.async('string'));
  const opfDir = dirOf(rootPath);

  const metaNode = opf.querySelector('metadata') || opf;
  const meta = {
    title: metaText(metaNode, ['dc:title', 'title']),
    creator: metaText(metaNode, ['dc:creator', 'creator']),
    language: metaText(metaNode, ['dc:language', 'language']),
    publisher: metaText(metaNode, ['dc:publisher', 'publisher']),
    description: metaText(metaNode, ['dc:description', 'description']),
  };

  const manifest = new Map();
  Array.from(opf.querySelectorAll('manifest > item')).forEach((item) => {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (!id || !href) return;
    manifest.set(id, {
      id,
      href,
      path: joinPath(opfDir, href),
      mediaType: item.getAttribute('media-type') || '',
      properties: item.getAttribute('properties') || '',
    });
  });

  const spine = [];
  Array.from(opf.querySelectorAll('spine > itemref')).forEach((ref) => {
    const item = manifest.get(ref.getAttribute('idref'));
    if (!item) return;
    spine.push({
      id: item.id,
      path: item.path,
      href: item.href,
      mediaType: item.mediaType,
      linear: ref.getAttribute('linear') !== 'no',
    });
  });

  // ---- 目录 ----
  let toc = [];
  const navItem = Array.from(manifest.values()).find((m) => /nav/.test(m.properties));
  const ncxId = opf.querySelector('spine')?.getAttribute('toc');
  const ncxItem = ncxId ? manifest.get(ncxId) : Array.from(manifest.values()).find((m) => m.mediaType === 'application/x-dtbncx+xml');

  if (navItem) {
    try {
      const f = zipFile(zip, navItem.path);
      if (f) {
        const navDoc = parseXml(await f.async('string'), 'text/html');
        const nav = Array.from(navDoc.querySelectorAll('nav')).find((n) =>
          /toc/i.test(n.getAttribute('epub:type') || n.getAttribute('type') || ''));
        const list = nav || navDoc;
        list.querySelectorAll('a[href]').forEach((a) => {
          toc.push({
            label: a.textContent.replace(/\s+/g, ' ').trim(),
            href: a.getAttribute('href'),
            path: joinPath(dirOf(navItem.path), a.getAttribute('href')),
            fragment: (a.getAttribute('href').split('#')[1] || ''),
            level: Math.min(3, Number(a.closest('ol')?.parentElement?.tagName === 'LI' ? 1 : 0) || 0),
          });
        });
      }
    } catch { /* 回退到 NCX */ }
  }

  if (!toc.length && ncxItem) {
    try {
      const f = zipFile(zip, ncxItem.path);
      if (f) {
        const ncx = parseXml(await f.async('string'));
        Array.from(ncx.querySelectorAll('navPoint')).forEach((np) => {
          const src = np.querySelector('content')?.getAttribute('src') || '';
          toc.push({
            label: np.querySelector('navLabel > text')?.textContent?.trim() || '',
            href: src,
            path: joinPath(dirOf(ncxItem.path), src),
            fragment: (src.split('#')[1] || ''),
            level: Math.max(0, Math.min(2, Number(np.parentElement.closest('navPoint') ? 1 : 0))),
          });
        });
      }
    } catch { /* ignore */ }
  }

  // ---- 封面 ----
  let coverHref = '';
  const coverId = opf.querySelector('metadata > meta[name="cover"]')?.getAttribute('content');
  if (coverId && manifest.get(coverId)) coverHref = manifest.get(coverId).path;
  if (!coverHref) {
    const byProp = Array.from(manifest.values()).find((m) => /cover-image/.test(m.properties));
    if (byProp) coverHref = byProp.path;
  }
  if (!coverHref) {
    const byName = Array.from(manifest.values()).find((m) => /cover/i.test(m.href) && /image/i.test(m.mediaType));
    if (byName) coverHref = byName.path;
  }

  return { meta, spine, manifest, toc, opfPath: rootPath, opfDir, coverHref };
}

/* ---------------- TXT 分章 ---------------- */

const CHAPTER_RE = /^\s*(第[0-9零一二三四五六七八九十百千两]{1,8}[章节回卷篇][^\n]{0,30}|Chapter\s+[0-9IVXLC]+[^\n]{0,30}|CHAPTER\s+[0-9IVXLC]+[^\n]{0,30}|\d{1,4}[、.．]\s*[^\n]{1,30})$/;

export function splitTxt(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const marks = [];
  lines.forEach((line, i) => {
    if (line.trim().length <= 40 && CHAPTER_RE.test(line.trim())) {
      marks.push({ line: i, title: line.trim() });
    }
  });

  if (marks.length < 2) {
    return [{ title: '正文', content: text.trim() }];
  }

  if (marks[0].line > 0) {
    const head = lines.slice(0, marks[0].line).join('\n').trim();
    if (head.length > 40) marks.unshift({ line: 0, title: '开始' });
  }

  const chapters = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].line;
    const end = i + 1 < marks.length ? marks[i + 1].line : lines.length;
    const content = lines.slice(start + 1, end).join('\n').trim();
    chapters.push({ title: marks[i].title, content });
  }
  return chapters;
}
