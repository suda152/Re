/* ===========================================================
   Re · 应用入口
   =========================================================== */

import { $, $$, toast, confirmDialog, escapeHtml, clamp, fallbackCover, fmtBytes, naturalCompare, makeCover, uid } from './util.js';
import { db } from './db.js';
import { state, prefs, mergePrefs, on, emit } from './state.js';
import { initLibrary, renderAll, renderShelf, renderRecent, renderStats, renderStorage, setEmptyImportHandler, clearSelection, hasSelection, closeCtxMenu } from './library.js';
import { parsePart, stagedComicPart, stagedPdfPart, detectType, MAX_BOOKS, TYPE_LABEL } from './import.js';
import { seriesInfo, bookParts, partKey, sortParts, cleanPart, recalcBook, makeBook, formalTitle } from './parts.js';
import { openBook, handleBack as readerBack, flushProgress, isReaderOpen } from './reader.js';
import { initPlatform, platform, onPlatform, platformText } from './platform.js';
import { native } from './native.js';

/* ---------------- 主题 ---------------- */

const mql = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const want = prefs.theme === 'system' ? (mql.matches ? 'dark' : 'light') : prefs.theme;
  document.documentElement.dataset.theme = want;
  $$('#themeSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.themeVal === prefs.theme);
  });
}

mql.addEventListener('change', () => { if (prefs.theme === 'system') applyTheme(); });

/* ---------------- 视图切换 ---------------- */

const VIEW_META = {
  library: ['书架', '全部藏书'],
  recent: ['最近阅读', '按上次阅读时间排序'],
  stats: ['阅读概览', '书库统计'],
  settings: ['设置', '外观与数据'],
};

/** 导航顺序，决定板块切换时滑动动画的方向 */
const VIEW_ORDER = ['library', 'recent', 'stats', 'settings'];

function switchView(view) {
  if (!VIEW_META[view]) return;
  const prev = document.body.dataset.view || 'library';
  if (state.view !== view) clearSelection();
  state.view = view;
  document.body.dataset.view = view;
  $$('.nav-item').forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  const forward = VIEW_ORDER.indexOf(view) > VIEW_ORDER.indexOf(prev);
  $$('.view').forEach((v) => {
    const on = v.id === `view-${view}`;
    v.hidden = !on;
    v.classList.remove('slide-next', 'slide-prev');
    if (on && view !== prev) v.classList.add(forward ? 'slide-next' : 'slide-prev');
  });
  const [title, sub] = VIEW_META[view];
  $('#viewTitle').textContent = title;
  $('#viewSub').textContent = sub;
  $('#content').scrollTop = 0;

  if (view === 'library') renderShelf();
  else if (view === 'recent') renderRecent();
  else if (view === 'stats') { renderStats(); renderStorage(); }
  else if (view === 'settings') { renderStorage(); syncDefaultControls(); syncDeviceControls(); }
}

/* ---------------- 导入 ---------------- */

/** 每批入库多少个分段：中断只影响当前批，已入库的照样可读 */
const PART_BATCH = 20;

/** 原生一次最多返回 5000 个文件，这里只用于提示 */
const MAX_FILES_PER_TREE = 5000;

/** 目录导入中途停止 */
let importAbort = false;

function openImportPanel(total, title = '正在导入') {
  const panel = $('#importPanel');
  const list = $('#importList');
  panel.hidden = false;
  list.innerHTML = '';
  const head = $('#importTitle');
  if (head) head.textContent = title;
  const cancel = $('#importCancel');
  if (cancel) cancel.hidden = false;
  $('#importCount').textContent = `0 / ${total}`;
  return list;
}

function closeImportPanel(delay = 2400) {
  importAbort = false;
  const cancel = $('#importCancel');
  if (cancel) cancel.hidden = true;
  setTimeout(() => { $('#importPanel').hidden = true; }, delay);
}

function setImportCount(done, total, extra) {
  $('#importCount').textContent = extra ? `${done} / ${total} · ${extra}` : `${done} / ${total}`;
}

function addRow(list, name, state = 'busy', note = '等待') {
  const li = document.createElement('li');
  li.className = state;
  li.innerHTML = `<i></i><span>${escapeHtml(name)}</span><em>${escapeHtml(note)}</em>`;
  list.appendChild(li);
  return li;
}

function setRow(row, cls, text) {
  if (!row) return;
  row.className = cls;
  const em = row.querySelector('em');
  if (em) em.textContent = text;
}

/** 让出一帧，长循环里保住 UI 响应（取消按钮、滚动） */
const breathe = () => new Promise((r) => setTimeout(r, 0));

async function ensureSpace(bytes) {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est || !est.quota) return;
    if (est.usage + bytes * 1.25 > est.quota * 0.97) {
      throw new Error('存储空间不足，请先清理一些书');
    }
  } catch (err) {
    if (err.message?.includes('存储空间')) throw err;
  }
}

/* ---- 落盘：目录导入的条目已在磁盘上，只登记索引 ---- */

async function persistItem(it) {
  if (it.staged) {
    await db.adoptFile(it.part.id, it.staged);
    return;
  }
  await ensureSpace(it.file.size);
  await db.putFile(it.part.id, it.file);
}

/**
 * 把解析好的分段分组写库 —— 拖拽/多选导入与目录导入共用
 * @param {Array<{part:Object, file?:File, staged?:Object, row?:HTMLElement}>} items
 * @param {{silent?:boolean}} opts silent 时不弹提示（分批调用由调用方汇总）
 * @returns {Promise<{ok:number, merged:number, added:number}>}
 */
async function commitItems(items, { silent = false } = {}) {
  if (!items.length) return { ok: 0, merged: 0, added: 0 };

  /* 1. 同系列（同一本书的不同卷/章）归到一组；没有编号的文件各自成书 */
  const groups = new Map();
  for (const item of items) {
    const p = item.part;
    const series = p.type === 'pdf' ? null : (partSeries(p) || dirSeriesOf(item, p));
    const key = series ? `${p.type}::${series.key}` : `solo::${p.id}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, type: p.type, series, titleHint: series?.base || '', items: [] };
      groups.set(key, g);
    }
    g.items.push(item);
  }

  /* 2. 逐组写库：能挂到已有书上就追加分段，否则新建一本 */
  let ok = 0;
  let merged = 0;
  let added = 0;

  for (const g of groups.values()) {
    const existing = g.series ? findSeriesBook(g.type, g.series.key) : null;
    try {
      if (existing) {
        const have = new Set(bookParts(existing).map(partKey));
        const next = [];
        for (const it of g.items) {
          const k = partKey(it.part);
          if (have.has(k)) {
            setRow(it.row, 'ok', '已在书中');
            continue;
          }
          have.add(k);
          next.push(it);
        }
        if (!next.length) continue;

        for (const it of next) await persistItem(it);
        existing.parts = sortParts([
          ...bookParts(existing).map(cleanPart),
          ...next.map((it) => cleanPart(it.part)),
        ]);
        if (!existing.series) existing.series = { ...g.series };
        recalcBook(existing);
        await db.putBook(existing);

        for (const it of next) {
          setRow(it.row, 'ok', '已并入');
          ok++;
          merged++;
        }
      } else {
        // 没有卷号的单本：同一个文件重复导入时不再新建
        const owner = findPartOwner(g.items[0].part);
        if (owner) {
          setRow(g.items[0].row, 'ok', '已在书中');
          continue;
        }
        if (state.books.length >= MAX_BOOKS) throw new Error(`书架最多 ${MAX_BOOKS} 本`);
        const first = g.items[0].part;
        // 带卷/章编号时用去掉编号的书名，后续追加分段也不会变成「夜航 01」
        // 再做一次正式化，杜绝「xxxx 第一话」这类占位名
        const title = formalTitle(g.titleHint || first.title || '') || '未命名';
        // 封面取第一个有真实封面的分段（优先第一话），提取失败自动顺延
        const withCover = g.items.map((it) => it.part).find((p) => p.cover && !p.coverDerived);
        const book = makeBook(g.items.map((it) => cleanPart(it.part)), {
          type: g.type,
          title,
          author: first.author || '',
          cover: withCover
            ? withCover.cover
            : fallbackCover(title, TYPE_LABEL[g.type] || ''),
          series: g.series ? { ...g.series } : null,
        });

        for (const it of g.items) await persistItem(it);
        await db.putBook(book);
        state.books.unshift(book);

        for (const it of g.items) {
          setRow(it.row, 'ok', g.items.length > 1 ? '已归入本书' : '已导入');
          ok++;
        }
        added++;
      }
    } catch (err) {
      for (const it of g.items) {
        // 已经写成功的行不要被后一个分组的失败冲掉
        if (it.row?.classList.contains('ok')) continue;
        setRow(it.row, 'err', err.message || '失败');
      }
      if (!silent) console.warn('导入分组失败', g.key, err);
    }
  }

  return { ok, merged, added };
}

/** 拖拽 / 多选导入：文件在 JS 手上，先解析再写库 */
async function importFiles(fileList) {
  const seen = new Set();
  const files = [];
  for (const f of Array.from(fileList || [])) {
    if (!f || !f.size) continue;
    const sig = `${f.name}|${f.size}|${f.lastModified || 0}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    files.push(f);
  }
  if (!files.length) return;

  importAbort = false;
  const list = openImportPanel(files.length);
  const rows = files.map((f) => addRow(list, f.name));

  const items = [];
  for (let i = 0; i < files.length; i++) {
    setRow(rows[i], 'busy', '解析中');
    try {
      items.push({ part: await parsePart(files[i]), file: files[i], row: rows[i] });
    } catch (err) {
      setRow(rows[i], 'err', err.message || '失败');
    }
    setImportCount(i + 1, files.length);
    await breathe();
  }

  const { ok, merged, added } = await commitItems(items);
  renderAll();
  await renderStorage();

  if (!ok) toast('没有导入任何文件', 'err');
  else if (merged && added) toast(`新增 ${added} 本，另有 ${merged} 个文件并入已有书目`);
  else if (merged) toast(`${merged} 个文件已并入已有书目`);
  else if (added === 1 && ok === 1) toast('已导入，开始阅读吧');
  else toast(`已导入 ${added} 本`);

  closeImportPanel(2400);
}

/* ---------------- 目录导入（批量） ---------------- */

/** 把原生落盘的文件读成 File，只给 epub / txt 这类小文件用 */
async function fileFromStaged(staged, name) {
  const uri = `file://${staged.absPath || ''}`;
  const src = window.Capacitor?.convertFileSrc ? window.Capacitor.convertFileSrc(uri) : uri;
  const res = await fetch(src);
  if (!res.ok) throw new Error('读取文件失败');
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type || '' });
}

/**
 * 一个目录条目 → 分段
 * 漫画：页数与封面都由原生给，不解压整包
 */
async function stageEntry(entry) {
  const id = uid();
  const staged = await native.stageFile(entry, id);
  if (!staged || !staged.path) throw new Error('写入失败');

  const kind = detectType(entry.name);
  const size = staged.size || entry.size || 0;
  const base = { path: staged.path, size, name: entry.name };

  if (kind?.type === 'comic') {
    if (!staged.pages) throw new Error('压缩包里没有图片');
    const blob = await native.coverBlob(staged.coverPath);
    const cover = blob ? await makeCover(blob) : null;
    return {
      part: stagedComicPart({ id, name: entry.name, size, pages: staged.pages, cover }),
      staged: { ...base, type: 'application/vnd.comicbook+zip' },
    };
  }

  if (kind?.type === 'pdf') {
    return {
      part: stagedPdfPart({ id, name: entry.name, size }),
      staged: { ...base, type: 'application/pdf' },
    };
  }

  // epub / txt：体积小，走原有解析拿封面与章节数
  const file = await fileFromStaged(staged, entry.name);
  const part = await parsePart(file);
  part.id = id;
  return { part, staged: { ...base, size: file.size || size, type: file.type || '' } };
}

/** 选目录 → 体检 → 分批导入 */
async function importFolder() {
  if (!native.folder) {
    toast('当前版本不支持目录导入', 'err');
    return;
  }

  let picked = null;
  try {
    picked = await native.pickFolder(
      'content://com.android.externalstorage.documents/document/primary%3ADownload'
    );
  } catch (err) {
    const msg = String(err?.message || err || '');
    if (/cancel/i.test(msg)) return;
    toast(msg || '打开目录选择器失败', 'err');
    return;
  }
  if (!picked) return;

  /* 过滤、去重、按路径自然排序 */
  const entries = [];
  const seen = new Set();
  let rar = 0;
  for (const f of picked.files) {
    if (!f || !f.name) continue;
    if (/\.(cbr|rar)$/i.test(f.name)) { rar++; continue; }
    if (!detectType(f.name)) continue;
    const sig = `${f.relPath || f.name}|${f.size || 0}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    entries.push(f);
  }
  entries.sort((a, b) => naturalCompare(a.relPath || a.name, b.relPath || b.name));

  if (!entries.length) {
    toast(rar ? '目录里只有 CBR / RAR，需要先转成 CBZ' : '这个目录里没有可导入的文件', 'err');
    return;
  }

  const totalBytes = entries.reduce((s, f) => s + (f.size || 0), 0);
  const folderTitle = folderNameFromTreeUri(picked.treeUri, entries);
  const folderKey = folderTitle.toLowerCase().replace(/[\s_.·\-—,，、:：]/g, '');
  const bookTitle = formalTitle(folderTitle) || '未命名';
  const tip = [
    `发现 ${entries.length} 个文件，约 ${fmtBytes(totalBytes)}。`,
    `整个目录会合并为一本《${bookTitle}》，封面用第一话。`,
    picked.truncated ? `已达单次 ${MAX_FILES_PER_TREE} 个上限，其余文件没有列出。` : '',
    rar ? `另有 ${rar} 个 CBR / RAR 无法导入，已跳过。` : '',
    '文件会复制到应用内，原目录保持不动。',
  ].filter(Boolean).join('');

  const go = await confirmDialog({ title: '导入整书', text: tip, ok: '开始导入', danger: false });
  if (!go) return;

  importAbort = false;
  const list = openImportPanel(entries.length, '正在批量导入');
  const rows = entries.map((f) => addRow(list, f.relPath || f.name));

  // 先查重：已经在书架里的文件不再复制一遍，省时间也省空间
  const haveKeys = new Set();
  for (const b of state.books) {
    for (const p of bookParts(b)) haveKeys.add(partKey(p));
  }

  let ok = 0;
  let added = 0;
  let failed = 0;
  let skipped = 0;
  const stagedItems = [];

  // 全部分段先落盘，最后统一合成一本书
  for (let i = 0; i < entries.length; i += PART_BATCH) {
    if (importAbort) break;
    const batch = [];
    const end = Math.min(i + PART_BATCH, entries.length);

    for (let j = i; j < end; j++) {
      if (importAbort) break;
      const entry = entries[j];

      // 同名同大小已经有记录：直接标为已在书中，不再落盘
      if (entry.size > 0 && haveKeys.has(`${entry.name}|${entry.size}`)) {
        setRow(rows[j], 'ok', '已在书中');
        skipped++;
        setImportCount(j + 1, entries.length, entry.name);
        continue;
      }

      setRow(rows[j], 'busy', '写入中');
      try {
        const item = await stageEntry(entry);
        item.row = rows[j];
        batch.push(item);
      } catch (err) {
        setRow(rows[j], 'err', err.message || '失败');
        failed++;
      }
      setImportCount(j + 1, entries.length, entry.name);
      await breathe();
    }

    stagedItems.push(...batch);
  }

  if (stagedItems.length) {
    try {
      const res = await commitFolderBook(stagedItems, folderTitle, folderKey);
      ok = res.ok;
      added = res.added;
    } catch (err) {
      for (const it of stagedItems) {
        if (it.row && !it.row.classList.contains('ok')) setRow(it.row, 'err', err.message || '失败');
      }
      failed += stagedItems.length;
    }
  }

  await native.clearCovers();
  // 中断留下的半截文件、判重后丢弃的副本，一并清掉
  const swept = await db.sweepFiles();
  renderAll();
  await renderStorage();

  const cleaned = swept?.removed ? `，清理 ${swept.removed} 个残片` : '';

  if (importAbort) toast(`已停止，已写入 ${ok} 个文件${cleaned}`);
  else if (!ok && skipped) toast(`这 ${skipped} 个文件都已在书架里${cleaned}`);
  else if (!ok) toast(failed ? '全部写入失败' : '没有导入任何文件', 'err');
  else if (failed) toast(`已导入 ${ok} 个文件，${failed} 个失败${cleaned}`);
  else if (added > 1) toast(`已导入 ${ok} 个文件，新增 ${added} 本${cleaned}`);
  else toast(`已导入 ${ok} 个文件${cleaned}`);

  closeImportPanel(failed ? 6000 : 2400);
}

/**
 * 判断文件属于哪个系列
 * 优先用文件名主干；文件名只剩「第一章」这类编号时，EPUB 退回用元数据标题兜底
 */
function partSeries(part) {
  if (part.grouped) return { key: part.seriesKey, base: part.seriesBase };
  if (part.type === 'epub' && !part.seriesHasBase) {
    const meta = seriesInfo(part.title || '');
    if (meta.hasBase) return { key: meta.key, base: meta.base };
  }
  return null;
}

/** 找同一系列的书：同类型 + 文件名主干一致（上限 2000 分段） */
function findSeriesBook(type, key) {
  if (!key) return null;
  return state.books.find((b) => b.type === type
    && (b.series?.key || seriesInfo(b.title || '').key) === key
    && bookParts(b).length < 2000) || null;
}

/**
 * 目录导入的系列名兜底：文件名只有「第01话」这类纯编号、没有主干时，
 * 用所在文件夹的名字当书名（manga/海贼王/第01话.cbz →《海贼王》），
 * 避免出现「第01话」这种占位书名。
 */
function dirSeriesOf(item, part) {
  const hint = item?.dirHint;
  if (!hint) return null;
  // 文件名自己带主干（哪怕带了编号）时，优先用文件名，不用文件夹
  if (seriesInfo(part?.name || '').hasBase) return null;
  return {
    key: hint.toLowerCase().replace(/[\s_.·\-—,，、:：]/g, ''),
    base: hint,
  };
}

/** 目录导入：relPath 的第一级文件夹名，没有就返回空 */
function folderHintOf(relPath) {
  const seg = String(relPath || '').split('/');
  return seg.length > 1 && seg[0] ? seg[0] : '';
}

/**
 * 所选目录的名字：从 SAF treeUri 解码（tree/primary%3ADownload%2F海贼王 → 海贼王），
 * 解不出来就退回第一个文件的顶层文件夹，最后兜底「导入合集」
 */
function folderNameFromTreeUri(treeUri, entries) {
  try {
    const m = /\/tree\/([^/?]+)/.exec(String(treeUri || ''));
    if (m) {
      const docId = decodeURIComponent(m[1]);   // 如 primary:Download/海贼王
      const seg = (docId.split(':').pop() || '').split('/').filter(Boolean).pop();
      if (seg) return seg;
    }
  } catch { /* 解析失败走兜底 */ }
  return folderHintOf(entries[0]?.relPath || '') || '导入合集';
}

/**
 * 目录导入整书：所选目录 = 一本书
 * - 书名用目录名（过 formalTitle），封面固定用第一话（排序后首个分段）的真实封面
 * - 混合类型目录极少见：按类型拆开，各自成一本，非主类型书名追加类型标签
 * - 同一目录重复导入 / 中断后续导：按 folderKey 找到旧书并入，不重复建
 */
async function commitFolderBook(items, folderTitle, folderKey) {
  const byType = new Map();
  for (const it of items) {
    const t = it.part.type || 'txt';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(it);
  }

  let ok = 0;
  let added = 0;

  for (const [type, list] of byType) {
    const title = formalTitle(folderTitle) || '未命名';
    const bookTitle = byType.size > 1 ? `${title}·${TYPE_LABEL[type] || type}` : title;

    const existing = folderKey
      ? state.books.find((b) => b.type === type && b.folderKey === folderKey)
      : null;

    if (existing) {
      const have = new Set(bookParts(existing).map(partKey));
      const next = [];
      for (const it of list) {
        const k = partKey(it.part);
        if (have.has(k)) { setRow(it.row, 'ok', '已在书中'); continue; }
        have.add(k);
        next.push(it);
      }
      if (next.length) {
        for (const it of next) await persistItem(it);
        existing.parts = sortParts([
          ...bookParts(existing).map(cleanPart),
          ...next.map((it) => cleanPart(it.part)),
        ]);
        // 已有书的封面（第一话）保持不动，不因追加而变
        recalcBook(existing);
        await db.putBook(existing);
      }
      for (const it of next) { setRow(it.row, 'ok', '已并入'); ok++; }
      continue;
    }

    if (state.books.length >= MAX_BOOKS) throw new Error(`书架最多 ${MAX_BOOKS} 本`);

    // 目录内同名同大小的重复文件只留一份
    const seen = new Set();
    const unique = list.filter((it) => {
      const k = partKey(it.part);
      if (seen.has(k)) { setRow(it.row, 'ok', '已在书中'); return false; }
      seen.add(k);
      return true;
    });

    // 封面 = 第一个有真实封面的分段（优先第一话；第一话提取失败时自动顺延）
    const parts = sortParts(unique.map((it) => cleanPart(it.part)));
    const withCover = parts.find((p) => p.cover && !p.coverDerived);
    const cover = withCover ? withCover.cover : fallbackCover(bookTitle, TYPE_LABEL[type] || '');

    const book = makeBook(parts, { type, title: bookTitle, cover, series: null, folderKey });
    for (const it of unique) await persistItem(it);
    await db.putBook(book);
    state.books.unshift(book);

    for (const it of unique) { setRow(it.row, 'ok', '已归入本书'); ok++; }
    added++;
  }

  return { ok, added };
}

/** 这个文件是否已经在某本书里（同名同大小） */
function findPartOwner(part) {
  return state.books.find((b) => bookParts(b)
    .some((p) => p.name === part.name && p.size === part.size)) || null;
}

/* ---------------- 拖拽 ---------------- */

let dragDepth = 0;
const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

function bindDrop() {
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    $('#dropVeil').hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#dropVeil').hidden = true;
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#dropVeil').hidden = true;
    await importFiles(e.dataTransfer.files);
  });
}

/* ---------------- 设置页控件 ---------------- */

function syncDefaultControls() {
  $('#defFontVal').textContent = String(prefs.epub.fontSize);
  $$('#defComicMode button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === prefs.comic.mode);
  });
}

/** 平板相关开关 + 当前环境描述 */
function syncDeviceControls() {
  const d = prefs.device || {};
  $$('[data-dev]').forEach((b) => {
    b.classList.toggle('active', !!d[b.dataset.dev] === (b.dataset.val === '1'));
  });
  const info = $('#devInfo');
  if (info) info.textContent = platformText();
}

/* ---------------- 系统返回 ---------------- */

/**
 * 安卓返回键 / 返回手势
 * 顺序：阅读器 → 面板 → 对话框 → 右键菜单 → 多选
 * @returns {boolean} true 表示这次返回被 App 吃掉，不退出
 */
function onSystemBack() {
  if (readerBack()) return true;
  const dlg = Array.from(document.querySelectorAll('dialog[open]')).pop();
  if (dlg) {
    dlg.dispatchEvent(new Event('cancel', { cancelable: true }));
    if (dlg.open) dlg.close();
    return true;
  }
  if (closeCtxMenu()) return true;
  if (hasSelection()) { clearSelection(); return true; }
  return false;
}

async function savePrefs() {
  await db.setPref('prefs', prefs);
}

/* ---------------- 全局绑定 ---------------- */

function bindGlobal() {
  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (btn) switchView(btn.dataset.view);
  });

  const input = $('#fileInput');
  // 原生壳优先走系统文件选择器（SAF），拿不到持久权限时再退回 input
  const pickFilesNow = async () => {
    if (native.picker) {
      try {
        const files = await native.pickFiles();
        if (files && files.length) { await importFiles(files); return; }
        if (files) return; // 用户在系统选择器里点了取消
      } catch (err) {
        console.warn(err);
        toast('系统选择器不可用，改用文件浏览', 'err');
      }
    }
    input.click();
  };

  /** 支持目录导入时先让用户选「文件还是文件夹」 */
  const startImport = () => {
    if (!native.folder) { pickFilesNow(); return; }
    const dlg = $('#importMenu');
    if (!dlg) { pickFilesNow(); return; }
    const close = () => dlg.close();
    $('#importPickFiles').onclick = async () => { close(); await pickFilesNow(); };
    $('#importPickFolder').onclick = async () => { close(); await importFolder(); };
    $('#importMenuCancel').onclick = close;
    if (!dlg.open) dlg.showModal();
  };

  $('#btnImport').addEventListener('click', startImport);
  setEmptyImportHandler(startImport);
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    input.value = '';
    await importFiles(files);
  });

  // 批量导入可以中途停：已入库的保留，未处理的放弃
  const cancelBtn = $('#importCancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      importAbort = true;
      cancelBtn.textContent = '正在停止…';
      setTimeout(() => { cancelBtn.textContent = '停止'; }, 1200);
    });
  }

  // 清掉选文件留下的缓存副本（批量导入前若空间紧张可先点一下）
  const clearBtn = $('#btnClearImportCache');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      const res = await native.clearCache();
      if (!res) { toast('浏览器里没有导入缓存', 'err'); return; }
      toast(`已清理 ${fmtBytes(res.freed || 0)}`);
      await renderStorage();
    });
  }

  $$('[data-action="clear-all"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.books.length) {
        toast('书架已经是空的');
        return;
      }
      const ok = await confirmDialog({
        title: '清空全部数据？',
        text: `将删除 ${state.books.length} 本书、全部阅读进度和阅读设置。此操作不可撤销。`,
        ok: '全部清空',
      });
      if (!ok) return;
      await db.clearAll();
      await db.setPref('prefs', prefs); // 保留外观偏好
      state.books = [];
      renderAll();
      await renderStorage();
      toast('已清空');
    });
  });

  $$('#themeSeg button').forEach((b) => {
    b.addEventListener('click', async () => {
      prefs.theme = b.dataset.themeVal;
      applyTheme();
      await savePrefs();
    });
  });

  $('#defFont').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-def]');
    if (!btn) return;
    prefs.epub.fontSize = clamp(prefs.epub.fontSize + Number(btn.dataset.val), 14, 32);
    syncDefaultControls();
    await savePrefs();
  });

  $('#defComicMode').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    prefs.comic.mode = btn.dataset.mode;
    syncDefaultControls();
    await savePrefs();
  });

  // 平板专属开关
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-dev]');
    if (!btn) return;
    prefs.device = { ...(prefs.device || {}), [btn.dataset.dev]: btn.dataset.val === '1' };
    syncDeviceControls();
    await savePrefs();
  });

  onPlatform(() => {
    syncDeviceControls();
    // 安全区/宽度变化后存储读数跟着更新
    renderStorage();
  });

  // 搜索：/ 聚焦，Esc 清空
  document.addEventListener('keydown', (e) => {
    if (state.view !== 'library') return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === '/') {
      e.preventDefault();
      $('#search').focus();
    } else if (e.key === 'Escape' && state.query) {
      $('#search').value = '';
      state.query = '';
      renderShelf();
    }
  });

  window.addEventListener('resize', () => {
    clearTimeout(window.__storageT);
    window.__storageT = setTimeout(() => { renderStorage(); }, 220);
  });

  on('open-book', (id) => {
    clearSelection();
    openBook(id);
  });
}

/* ---------------- 启动 ---------------- */

async function boot() {
  initPlatform();

  try {
    const saved = await db.getPref('prefs', null);
    mergePrefs(saved);
  } catch { /* 首次运行 */ }

  applyTheme();
  syncDefaultControls();
  syncDeviceControls();

  try {
    state.books = await db.allBooks();
  } catch (err) {
    console.error(err);
    toast('本地数据库无法打开，可能处于隐私模式', 'err');
    state.books = [];
  }

  state.ready = true;
  initLibrary();
  bindGlobal();
  bindDrop();
  native.init({
    back: onSystemBack,
    stateChange: (active) => { if (!active) flushProgress(); },
  });
  renderAll();
  switchView('library');
  renderStorage();
}

let booted = false;
function start() {
  if (booted) return;
  booted = true;
  boot();
}
document.addEventListener('DOMContentLoaded', start);
if (document.readyState !== 'loading') start();
