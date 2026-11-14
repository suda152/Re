/* ===========================================================
   书架 / 最近阅读 / 统计
   =========================================================== */

import {
  $, $$, escapeHtml, fmtBytes, fmtDate, fmtDuration, fmtDurationShort, naturalCompare, confirmDialog, toast, fallbackCover,
} from './util.js';
import { db } from './db.js';
import { state, emit, clamp01 } from './state.js';
import { TYPE_LABEL } from './import.js';
import { bookParts, partKey, cleanPart, sortParts, recalcBook, partChapterLabel, partUnit, formalTitle, seriesInfo } from './parts.js';
import { getDayLog, summarize, recentDays } from './tracker.js';

const TEXT_TYPES = ['epub', 'txt'];

export function typeText(book) {
  return TYPE_LABEL[book.type] || '书籍';
}

/**
 * 书架上的一行体量文案
 * 多分段（合并过的）按「章 / 册」区分，而不是只报总页数：
 *   漫画：3 章 · 120 页     文字：3 册 · 120 章
 */
export function countText(book) {
  const n = bookParts(book).length;
  const base = book.countLabel
    || (book.count ? `${book.count} ${book.type === 'comic' ? '页' : '章'}` : fmtBytes(book.size));
  if (n <= 1) return base;
  if (book.type === 'comic') {
    return book.count ? `${n} ${partUnit(book)} · ${book.count} 页` : `${n} ${partUnit(book)} · ${base}`;
  }
  if (book.type === 'pdf') return base;
  return book.count ? `${n} ${partUnit(book)} · ${book.count} 章` : `${n} ${partUnit(book)} · ${base}`;
}

/* ---------------- 筛选 / 排序 ---------------- */

export function visibleBooks() {
  const q = state.query.trim().toLowerCase();
  let list = state.books.slice();

  if (state.filter === 'comic') list = list.filter((b) => b.type === 'comic');
  else if (state.filter === 'epub') list = list.filter((b) => TEXT_TYPES.includes(b.type));
  else if (state.filter === 'reading') list = list.filter((b) => b.progress > 0 && !b.finished);
  else if (state.filter === 'finished') list = list.filter((b) => b.finished || b.progress >= 0.995);

  if (q) {
    list = list.filter((b) =>
      b.title.toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q));
  }

  switch (state.sort) {
    case 'title':
      list.sort((a, b) => naturalCompare(a.title, b.title));
      break;
    case 'progress':
      list.sort((a, b) => (b.progress || 0) - (a.progress || 0));
      break;
    case 'added':
      list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
      break;
    default:
      list.sort((a, b) => (b.lastReadAt || b.addedAt || 0) - (a.lastReadAt || a.addedAt || 0));
  }
  return list;
}

/* ---------------- 书架 ---------------- */

export function renderShelf() {
  const shelf = $('#shelf');
  const empty = $('#emptyState');
  const list = visibleBooks();

  const sub = $('#viewSub');
  if (sub && state.view === 'library') {
    sub.textContent = state.books.length ? `${state.books.length} 本藏书` : '把第一本书拖进来';
  }

  if (!state.books.length) {
    shelf.innerHTML = '';
    empty.hidden = false;
    empty.querySelector('h2').textContent = '书架还是空的';
    empty.querySelector('p').innerHTML = '把 cbz、epub、txt 文件拖进窗口，或点击右上角导入。<br>文件只保存在这台设备的浏览器里，不会上传到任何服务器。';
    shelf.classList.remove('selecting');
    syncSelectBar();
    return;
  }

  if (!list.length) {
    shelf.innerHTML = '';
    empty.hidden = false;
    empty.querySelector('h2').textContent = '没有符合条件的书';
    empty.querySelector('p').textContent = '换个关键词，或切回「全部」看看。';
    shelf.classList.remove('selecting');
    syncSelectBar();
    return;
  }
  empty.hidden = true;

  shelf.innerHTML = list.map((b) => {
    const pct = Math.round(clamp01(b.progress) * 100);
    const on = selected.has(b.id);
    return `<article class="card${on ? ' selected' : ''}" data-id="${b.id}" tabindex="0" role="button" aria-selected="${on}" aria-label="${escapeHtml(b.title)}">
      <div class="card-cover">
        <img src="${b.cover || ''}" alt="" loading="lazy" draggable="false">
        <span class="card-check" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>
        </span>
        ${b.isNew ? '<span class="badge-new">新</span>' : ''}
        <span class="badge-type">${typeText(b)}</span>
        <div class="card-progress"><i style="width:${pct}%"></i></div>
      </div>
      <h3 class="card-title">${escapeHtml(b.title)}</h3>
      <p class="card-meta"><span>${countText(b)}</span>${pct > 0 ? `<em>· ${pct}%</em>` : ''}</p>
    </article>`;
  }).join('');

  shelf.classList.toggle('selecting', selectMode || selected.size > 0);
  syncSelectBar();
}

/* ---------------- 最近阅读 ---------------- */

export function renderRecent() {
  const wrap = $('#recentList');
  const empty = $('#recentEmpty');
  const list = state.books
    .filter((b) => b.lastReadAt > 0)
    .sort((a, b) => b.lastReadAt - a.lastReadAt)
    .slice(0, 24);

  if (!list.length) {
    wrap.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  wrap.innerHTML = list.map((b) => {
    const pct = Math.round(clamp01(b.progress) * 100);
    return `<div class="recent-item" data-id="${b.id}" tabindex="0" role="button">
      <img src="${b.cover || ''}" alt="" loading="lazy">
      <div class="recent-main">
        <h4>${escapeHtml(b.title)}</h4>
        <p>${typeText(b)} · ${countText(b)} · ${fmtDate(b.lastReadAt)}</p>
        <div class="recent-bar"><i style="width:${pct}%"></i></div>
      </div>
      <div class="recent-side">
        <strong>${pct}%</strong>
        <span>继续阅读 →</span>
      </div>
    </div>`;
  }).join('');
}

/* ---------------- 统计 ---------------- */

export async function renderStats() {
  const grid = $('#statGrid');
  const books = state.books;
  const reading = books.filter((b) => b.progress > 0 && !b.finished).length;
  const finished = books.filter((b) => b.finished || b.progress >= 0.995).length;
  const size = books.reduce((s, b) => s + (b.size || 0), 0);

  grid.innerHTML = `
    <div class="stat"><span>藏书</span><strong>${books.length}<em>册</em></strong></div>
    <div class="stat"><span>在读</span><strong>${reading}<em>册</em></strong></div>
    <div class="stat"><span>读完</span><strong>${finished}<em>册</em></strong></div>
    <div class="stat"><span>文件体积</span><strong>${fmtBytes(size)}</strong></div>`;

  // 阅读时长：本周 / 本月 / 今年 / 总计（按天日志聚合，书上的是每本自己的）
  const log = await getDayLog();
  const sum = summarize(log);
  const timeGrid = $('#timeGrid');
  if (timeGrid) {
    timeGrid.innerHTML = [
      ['本周', sum.week], ['本月', sum.month], ['今年', sum.year], ['总时长', sum.total],
    ].map(([label, sec]) => {
      const [num, unit] = fmtDurationShort(sec);
      return `<div class="stat"><span>${label}</span><strong>${num}<em>${unit}</em></strong></div>`;
    }).join('');
  }

  // 近 7 天柱状图
  const dayBars = $('#dayBars');
  if (dayBars) {
    const days = recentDays(log, 7);
    const max = Math.max(60, ...days.map((d) => d.sec)); // 至少 1 分钟，避免一条都看不见
    dayBars.innerHTML = days.map((d) => {
      const [mm, dd] = d.day.slice(5).split('-');
      const label = Number(mm) === new Date().getMonth() + 1 && Number(dd) === new Date().getDate()
        ? '今天' : `${Number(mm)}/${Number(dd)}`;
      const [num, unit] = fmtDurationShort(d.sec);
      return `
        <div class="bar-row bar-day">
          <span>${label}</span>
          <div class="track"><i style="width:${d.sec ? Math.max(2, (d.sec / max) * 100) : 0}%"></i></div>
          <em>${d.sec ? `${num} ${unit}` : '—'}</em>
        </div>`;
    }).join('');
  }

  const groups = [
    ['漫画', books.filter((b) => b.type === 'comic').length],
    ['小说', books.filter((b) => TEXT_TYPES.includes(b.type)).length],
    ['PDF', books.filter((b) => b.type === 'pdf').length],
  ];
  const max = Math.max(1, ...groups.map((g) => g[1]));
  $('#typeBars').innerHTML = groups.map(([label, n]) => `
    <div class="bar-row">
      <span>${label}</span>
      <div class="track"><i style="width:${(n / max) * 100}%"></i></div>
      <em>${n}</em>
    </div>`).join('');
}

/* ---------------- 存储 ---------------- */

export async function renderStorage() {
  const { used, quota } = await db.usage();
  const pct = quota ? Math.min(100, (used / quota) * 100) : 0;
  const narrow = window.innerWidth <= 1180;
  const text = narrow ? fmtBytes(used) : (quota ? `${fmtBytes(used)} / ${fmtBytes(quota)}` : fmtBytes(used));
  $('#storageText').textContent = text;
  $('#storageText').title = quota ? `已用 ${fmtBytes(used)}，配额 ${fmtBytes(quota)}` : `已用 ${fmtBytes(used)}`;
  $('#storageFill').style.width = `${Math.max(used > 0 ? 1.5 : 0, pct)}%`;
  const st = $('#settingsStorageText');
  if (st) st.textContent = quota
    ? `已用 ${fmtBytes(used)}，配额 ${fmtBytes(quota)}。清空后所有书与进度都会删除，无法恢复。`
    : `已用 ${fmtBytes(used)}。`;
}

export function setNavCount() {
  $('#navCount').textContent = state.books.length;
}

export function renderAll() {
  setNavCount();
  renderShelf();
  renderRecent();
  renderStats();
  renderStorage();
}

/* ===========================================================
   多选
   - Ctrl / Cmd + 点：逐本切换
   - Shift + 点：从上一本到这本的范围
   - 已有选中项时单击 = 切换（双击才是打开）
   =========================================================== */

const selected = new Set();
let anchorId = null;
let suppressClickUntil = 0;
// 多选模式：点顶栏「多选」进入，即使一本没选也保持操作条可见
let selectMode = false;

export function selectedIds() {
  return [...selected];
}

/** 是否处于多选状态（含「进入多选但还没选」） */
export function hasSelection() {
  return !!selected.size || selectMode;
}

export function clearSelection() {
  if (!selected.size && !selectMode) return;
  selected.clear();
  anchorId = null;
  selectMode = false;
  syncSelectionDom();
  syncSelectBar();
}

/** 顶栏「多选」按钮：进入 / 退出 */
export function toggleSelectMode() {
  if (selectMode) { clearSelection(); return; }
  selectMode = true;
  syncSelectionDom();
  syncSelectBar();
}

/** 只改 DOM class，不重绘整块书架，避免图片重新加载与滚动跳动 */
function syncSelectionDom() {
  const shelf = $('#shelf');
  if (!shelf) return;
  shelf.classList.toggle('selecting', selectMode || selected.size > 0);
  shelf.querySelectorAll('.card').forEach((c) => {
    const on = selected.has(c.dataset.id);
    c.classList.toggle('selected', on);
    c.setAttribute('aria-selected', String(on));
  });
}

/** 选中项里已不存在的书（被删/被合并）自动剔除 */
function pruneSelection() {
  if (!selected.size) return;
  const alive = new Set(state.books.map((b) => b.id));
  let changed = false;
  for (const id of [...selected]) {
    if (!alive.has(id)) { selected.delete(id); changed = true; }
  }
  if (changed) syncSelectionDom();
}

export function syncSelectBar() {
  const bar = $('#selectBar');
  if (!bar) return;
  pruneSelection();

  // 顶栏按钮跟着模式走
  $('#btnSelect')?.classList.toggle('active', selectMode);

  const show = (selectMode || selected.size > 0) && state.view === 'library';
  // 提示条要给底部操作条让位
  document.body.classList.toggle('has-selection', show);
  const hint = $('#shelfHint');
  if (hint) hint.hidden = !show;
  if (!show) {
    bar.hidden = true;
    const topAll = $('#btnSelectAll');
    if (topAll) topAll.hidden = true;
    return;
  }
  bar.hidden = false;

  const books = [...selected].map((id) => state.books.find((b) => b.id === id)).filter(Boolean);
  const types = new Set(books.map((b) => b.type));
  const files = books.reduce((sum, b) => sum + bookParts(b).length, 0);
  const canMerge = books.length >= 2 && types.size === 1 && !types.has('pdf');

  $('#selectCount').textContent = books.length;
  $('#selectMerge').disabled = !canMerge;

  const del = $('#selectDelete');
  if (del) {
    del.disabled = !books.length;
    del.textContent = books.length > 1 ? `删除 ${books.length} 本` : '删除';
  }

  let note = '';
  if (!books.length) note = '点选要合并的书';
  else if (books.length < 2) note = '再选一本才能合并';
  else if (types.size > 1) note = '只能合并同类型的书';
  else if (types.has('pdf')) note = 'PDF 不支持合并';
  else note = `${files} ${partUnit(books[0])} → 1 本`;
  $('#selectNote').textContent = note;
  $('#selectNote').title = note;

  const visible = visibleBooks().map((b) => b.id);
  const allOn = visible.length > 0 && visible.every((id) => selected.has(id));
  $('#selectAll').textContent = allOn ? '取消全选' : '全选';

  // 顶栏一键全选：不随列表滚动跑掉，平板和窄屏也能直接点到
  const topAll = $('#btnSelectAll');
  if (topAll) {
    topAll.hidden = false;
    const label = topAll.querySelector('span');
    if (label) label.textContent = allOn ? '取消全选' : '全选';
    topAll.title = allOn
      ? `取消全选（当前列表 ${visible.length} 本）`
      : `全选当前列表 ${visible.length} 本`;
  }
}

function toggleSelect(id, force) {
  if (!state.books.some((b) => b.id === id)) return;
  selectMode = true;
  const on = force == null ? !selected.has(id) : force;
  if (on) selected.add(id);
  else selected.delete(id);
  anchorId = id;
  syncSelectionDom();
  syncSelectBar();
}

function selectRange(id) {
  const list = visibleBooks().map((b) => b.id);
  const to = list.indexOf(id);
  const from = anchorId ? list.indexOf(anchorId) : to;
  if (to < 0) return;
  if (from < 0) { toggleSelect(id, true); return; }

  const [s, e] = from <= to ? [from, to] : [to, from];
  for (let i = s; i <= e; i++) selected.add(list[i]);
  syncSelectionDom();
  syncSelectBar();
}

function toggleSelectAll() {
  const visible = visibleBooks().map((b) => b.id);
  const allOn = visible.length > 0 && visible.every((id) => selected.has(id));
  visible.forEach((id) => { if (allOn) selected.delete(id); else selected.add(id); });
  anchorId = visible[0] || null;
  syncSelectionDom();
  syncSelectBar();
}

/* ---------------- 拖动 / 滑动连续选中 ----------------
   既有的点选、Ctrl 加减、Shift 连选、Ctrl+A 全部保持原样，
   这里只在多选状态下额外接管「按下后移动」的手势：
   - 从卡片上按下并划过：按书架顺序连续选中起点到当前卡片
   - 从空白处按下并拖动（鼠标）：拉框，框到的卡片一起选中
   - 触摸：横向滑动进入连选，纵向滑动仍然滚书架
   - 拖到上下边缘自动滚屏，选中状态逐帧刷新
--------------------------------------------------------- */

const DRAG_THRESHOLD = 7;

let drag = null;
let marqueeEl = null;
let scrollRAF = 0;
let paintRAF = 0;

function canDragSelect() {
  return state.view === 'library' && (selectMode || selected.size > 0);
}

function beginDrag(x, y, startId, pointerType) {
  const list = visibleBooks().map((b) => b.id);
  drag = {
    x,
    y,
    lastX: x,
    lastY: y,
    startId,
    pointerType,
    startIdx: startId ? list.indexOf(startId) : -1,
    // 拖动过程中列表不会变，缓存一次省掉每帧重排
    list,
    base: new Set(selected),
    // 从已选中的卡片起手 = 划掉，从没选中的起手 = 划上
    intentOn: startId ? !selected.has(startId) : true,
    moved: false,
    scrollBehavior: '',
  };
}

/** 逐帧合并刷新，拖动时不会因为频繁重绘而发涩 */
function paintSelection() {
  if (paintRAF) return;
  paintRAF = requestAnimationFrame(() => {
    paintRAF = 0;
    syncSelectionDom();
    syncSelectBar();
  });
}

function applyRange(from, to) {
  const list = drag.list;
  const [s, e] = from <= to ? [from, to] : [to, from];
  selected.clear();
  for (const id of drag.base) selected.add(id);
  for (let i = s; i <= e; i++) {
    const id = list[i];
    if (!id) continue;
    if (drag.intentOn) selected.add(id);
    else selected.delete(id);
  }
  selectMode = true;
  paintSelection();
}

function applyMarquee(x, y) {
  const left = Math.min(drag.x, x);
  const top = Math.min(drag.y, y);
  const w = Math.abs(x - drag.x);
  const h = Math.abs(y - drag.y);

  if (!marqueeEl) {
    marqueeEl = document.createElement('div');
    marqueeEl.className = 'shelf-marquee';
    document.body.appendChild(marqueeEl);
  }
  Object.assign(marqueeEl.style, {
    left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px`,
  });

  selected.clear();
  for (const id of drag.base) selected.add(id);
  for (const card of $$('#shelf .card')) {
    const r = card.getBoundingClientRect();
    if (r.right > left && r.left < left + w && r.bottom > top && r.top < top + h) {
      selected.add(card.dataset.id);
    }
  }
  selectMode = true;
  paintSelection();
}

function cardIdAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const card = el?.closest?.('.card');
  return card && card.closest('#shelf') ? card.dataset.id : null;
}

function startDragging() {
  drag.moved = true;
  $('#shelf')?.classList.add('dragging');
  document.body.classList.add('drag-selecting');
  const content = $('#content');
  if (content) {
    // 自动滚屏要即时生效，smooth 会让 scrollTop 追不上指针
    drag.scrollBehavior = content.style.scrollBehavior;
    content.style.scrollBehavior = 'auto';
  }
  tickScroll();
}

function moveDrag(x, y) {
  if (!drag) return;
  drag.lastX = x;
  drag.lastY = y;

  if (!drag.moved) {
    if (Math.hypot(x - drag.x, y - drag.y) < DRAG_THRESHOLD) return;
    startDragging();
  }

  if (drag.startIdx < 0) { applyMarquee(x, y); return; }

  const id = cardIdAt(x, y);
  const to = id ? drag.list.indexOf(id) : -1;
  if (to < 0) return;
  applyRange(drag.startIdx, to);
}

function tickScroll() {
  if (!drag) return;
  const content = $('#content');
  if (content) {
    const r = content.getBoundingClientRect();
    const edge = 58;
    let dy = 0;
    if (drag.lastY < r.top + edge) dy = -(r.top + edge - drag.lastY) / 4;
    else if (drag.lastY > r.bottom - edge) dy = (drag.lastY - (r.bottom - edge)) / 4;
    if (dy) {
      const step = Math.max(-26, Math.min(26, dy));
      const before = content.scrollTop;
      content.scrollTop = before + step;
      if (content.scrollTop !== before) moveDrag(drag.lastX, drag.lastY);
    }
  }
  scrollRAF = requestAnimationFrame(tickScroll);
}

function endDrag() {
  if (!drag) return;
  const moved = drag.moved;
  const content = $('#content');
  if (content && drag.scrollBehavior !== undefined) {
    content.style.scrollBehavior = drag.scrollBehavior;
  }
  drag = null;
  if (scrollRAF) cancelAnimationFrame(scrollRAF);
  scrollRAF = 0;
  $('#shelf')?.classList.remove('dragging');
  document.body.classList.remove('drag-selecting');
  if (marqueeEl) { marqueeEl.remove(); marqueeEl = null; }
  if (moved) {
    // 拖选松手后浏览器会补一个 click，别让它把刚划好的卡片又切掉
    suppressClickUntil = Date.now() + 400;
    syncSelectionDom();
    syncSelectBar();
  }
}

function initDragSelect(shelf) {
  shelf.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    if (!canDragSelect()) return;
    const card = e.target.closest('.card');
    beginDrag(e.clientX, e.clientY, card?.dataset.id || null, 'mouse');
  });

  window.addEventListener('pointermove', (e) => {
    if (!drag || drag.pointerType !== 'mouse') return;
    if (drag.moved) e.preventDefault();
    moveDrag(e.clientX, e.clientY);
  }, { passive: false });

  window.addEventListener('pointerup', (e) => {
    if (drag && drag.pointerType === 'mouse') endDrag();
  });
  window.addEventListener('pointercancel', (e) => {
    if (drag && drag.pointerType === 'mouse') endDrag();
  });
  window.addEventListener('blur', endDrag);

  /* 触摸：横向滑 = 连选，纵向滑 = 继续滚动书架 */
  shelf.addEventListener('touchstart', (e) => {
    if (!canDragSelect() || e.touches.length !== 1) return;
    const card = e.target.closest('.card');
    if (!card) return;
    const t = e.touches[0];
    beginDrag(t.clientX, t.clientY, card.dataset.id, 'touch');
  }, { passive: true });

  shelf.addEventListener('touchmove', (e) => {
    if (!drag || drag.pointerType !== 'touch') return;
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - drag.x;
    const dy = t.clientY - drag.y;
    if (!drag.moved) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { drag = null; return; }
      if (Math.abs(dx) < 10) return;
      startDragging();
    }
    e.preventDefault();
    moveDrag(t.clientX, t.clientY);
  }, { passive: false });

  shelf.addEventListener('touchend', () => endDrag());
  shelf.addEventListener('touchcancel', () => endDrag());
}

/* ---------------- 右键菜单 ---------------- */

let ctxId = null;

function closeCtx() {
  const menu = $('#ctxMenu');
  if (!menu.hidden) menu.hidden = true;
  ctxId = null;
}

/** 系统返回键用：菜单开着就先关菜单 */
export function closeCtxMenu() {
  const menu = $('#ctxMenu');
  if (!menu || menu.hidden) return false;
  closeCtx();
  return true;
}

export function openCtxMenu(x, y, id) {
  const menu = $('#ctxMenu');
  const book = state.books.find((b) => b.id === id);
  if (!book) return;
  ctxId = id;
  const picked = selected.has(id);

  menu.innerHTML = `
    <button data-act="select">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12.2l2.6 2.6 4.6-5"/></svg>
      ${picked ? '取消选择' : '选择（可多选合并）'}
    </button>
    <button data-act="read">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v18H6.5A2.5 2.5 0 0 1 4 18.5z"/><path d="M4 17.5h15"/></svg>
      ${book.progress > 0 ? '继续阅读' : '开始阅读'}
    </button>
    <button data-act="detail">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.5"/></svg>
      书籍详情
    </button>
    <button data-act="edit">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/></svg>
      编辑书名/作者
    </button>
    <button data-act="reset">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 4v4h4"/></svg>
      标记为未读
    </button>
    ${book.type !== 'pdf' ? `<button data-act="merge">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M7 4v6a3 3 0 0 0 3 3h7"/><path d="M14 10l3 3-3 3"/><path d="M7 20v-6"/></svg>
      合并到另一本
    </button>` : ''}
    <hr>
    <button data-act="delete" class="danger">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/></svg>
      ${picked && selected.size > 1 ? `删除选中的 ${selected.size} 本` : '删除'}
    </button>`;

  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;

  menu.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const id2 = ctxId;
    closeCtx();
    if (act === 'select') toggleSelect(id2, !picked);
    else if (act === 'read') emit('open-book', id2);
    else if (act === 'detail') openDetail(id2);
    else if (act === 'edit') openEdit(id2);
    else if (act === 'reset') await resetProgress(id2);
    else if (act === 'merge') openMergePicker(id2);
    else if (act === 'delete') {
      // 右键的这本在选中的一批里：按整批删，和操作条上的行为一致
      if (selected.has(id2) && selected.size > 1) await removeSelected();
      else await removeBook(id2);
    }
  };
}

/* ---------------- 合并多本 ---------------- */

/**
 * 右键「合并到另一本」时的候选列表
 * 如果右键的这本在选中集合里，就把整批选中一起并入目标
 */
function openMergePicker(sourceId) {
  const menu = $('#ctxMenu');
  const src = state.books.find((b) => b.id === sourceId);
  if (!src) return;

  const batch = selected.has(sourceId) && selected.size > 1
    ? [...selected].map((id) => state.books.find((b) => b.id === id)).filter(Boolean)
    : [src];
  const batchIds = new Set(batch.map((b) => b.id));
  const cands = state.books
    .filter((b) => !batchIds.has(b.id) && b.type === src.type && b.type !== 'pdf')
    .sort((a, b) => naturalCompare(a.title, b.title));

  if (!cands.length) {
    toast('没有可合并的同类型书籍');
    return;
  }

  const head = batch.length > 1
    ? `把选中的 ${batch.length} 本并入`
    : `把《${escapeHtml(src.title)}》并入`;

  menu.hidden = false;
  menu.innerHTML = `<div class="ctx-head">${head}</div>`
    + cands.slice(0, 40).map((b) => `<button data-target="${b.id}">
        <span class="ctx-name">${escapeHtml(b.title)}</span>
        <em class="ctx-sub">${escapeHtml(countText(b))}</em>
      </button>`).join('')
    + '<hr><button data-act="back">取消</button>';

  const rect = menu.getBoundingClientRect();
  const left = Math.min(parseFloat(menu.style.left) || 0, window.innerWidth - rect.width - 8);
  const top = Math.min(parseFloat(menu.style.top) || 0, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  menu.onclick = async (e) => {
    if (e.target.closest('[data-act="back"]')) { closeCtx(); return; }
    const btn = e.target.closest('[data-target]');
    if (!btn) return;
    const targetId = btn.dataset.target;
    closeCtx();
    if (batch.length > 1) await mergeBatchInto(targetId, batch);
    else await mergeBooks(sourceId, targetId);
  };
}

/** 多本 → 一本，带确认框 */
async function mergeBatchInto(targetId, sources) {
  const tgt = state.books.find((b) => b.id === targetId);
  if (!tgt) return;
  const files = sources.reduce((sum, b) => sum + bookParts(b).length, 0);
  const ok = await confirmDialog({
    title: '合并为一本？',
    text: `选中的 ${sources.length} 本、共 ${files} ${partUnit(tgt)}会并入《${tgt.title}》，按卷/章顺序排好。合并后这 ${sources.length} 条书目会消失，阅读进度保留《${tgt.title}》的。`,
    ok: '合并',
  });
  if (!ok) return;

  const { n, added } = await mergeInto(tgt.id, sources.map((b) => b.id));
  clearSelection();
  toast(`已把 ${n} 个章节并入《${tgt.title}》`);
  openMergeResult(tgt.id, added);
}

/**
 * 把若干本书并进 main（保留 main 的书名、封面与阅读进度）
 * 只合并书目记录，文件本身仍按分段 id 留在库里
 * @returns {Promise<{n: number, added: string[]}>} n 为实际并入的文件数，added 为新并入分段 id
 */
export async function mergeInto(mainId, sourceIds) {
  const main = state.books.find((b) => b.id === mainId);
  if (!main) return { n: 0, added: [] };
  const srcs = [...new Set(sourceIds)]
    .filter((id) => id !== mainId)
    .map((id) => state.books.find((b) => b.id === id))
    .filter(Boolean);
  if (!srcs.length) return { n: 0, added: [] };
  if (srcs.some((b) => b.type !== main.type)) { toast('只能合并同类型的书', 'err'); return { n: 0, added: [] }; }
  if (main.type === 'pdf') { toast('PDF 不支持合并', 'err'); return { n: 0, added: [] }; }

  const have = new Set(bookParts(main).map(partKey));
  const keep = [];
  const dupIds = [];
  for (const src of srcs) {
    for (const p of bookParts(src)) {
      const key = partKey(p);
      if (have.has(key)) { dupIds.push(p.id); continue; }
      have.add(key);
      keep.push(p);
    }
  }

  // 直接交给全局排序：跨书有卷号时能正确交错（如 01、02、03 分在两次导入里）
  main.parts = sortParts([...bookParts(main).map(cleanPart), ...keep.map(cleanPart)]);
  // 合并后的书名去掉「第X话」式占位编号，用正式的系列名
  main.title = formalTitle(main.title) || main.title;
  if (!main.cover) main.cover = srcs.find((b) => b.cover)?.cover || '';
  if (!main.author) main.author = srcs.find((b) => b.author)?.author || '';
  recalcBook(main);
  await db.putBook(main);

  for (const src of srcs) await db.deleteBookRecord(src.id);
  for (const id of dupIds) await db.deleteFile(id);

  const gone = new Set(srcs.map((b) => b.id));
  state.books = state.books.filter((b) => !gone.has(b.id));
  for (const id of gone) selected.delete(id);
  renderAll();
  return { n: keep.length, added: keep.map((p) => p.id) };
}

/** 单本合并：右键「合并到另一本」 */
export async function mergeBooks(sourceId, targetId) {
  const src = state.books.find((b) => b.id === sourceId);
  const tgt = state.books.find((b) => b.id === targetId);
  if (!src || !tgt || src.id === tgt.id) return;
  if (src.type !== tgt.type) { toast('只能合并同类型的书', 'err'); return; }

  const srcParts = bookParts(src);
  const ok = await confirmDialog({
    title: '合并为一本？',
    text: `《${src.title}》的 ${srcParts.length} ${partUnit(src)}会并入《${tgt.title}》，按卷/章顺序排好。合并后《${src.title}》这条书目会消失，阅读进度保留《${tgt.title}》的。`,
    ok: '合并',
  });
  if (!ok) return;

  const { n, added } = await mergeInto(tgt.id, [src.id]);
  toast(`已把 ${n} 个章节并入《${tgt.title}》`);
  openMergeResult(tgt.id, added);
}

/* ---------------- 多选合并 ---------------- */

/** 默认主书：分段最多 → 进度最高 → 书架顺序第一本 */
function pickMainBook(books) {
  return books.slice().sort((a, b) =>
    (bookParts(b).length - bookParts(a).length)
    || ((b.progress || 0) - (a.progress || 0)))[0];
}

function openMergeDialog() {
  const books = [...selected]
    .map((id) => state.books.find((b) => b.id === id))
    .filter(Boolean);
  if (books.length < 2) return;
  const types = new Set(books.map((b) => b.type));
  if (types.size > 1) { toast('只能合并同类型的书', 'err'); return; }
  if (types.has('pdf')) { toast('PDF 不支持合并', 'err'); return; }

  const main = pickMainBook(books);
  const total = books.reduce((sum, b) => sum + bookParts(b).length, 0);

  $('#mergeLead').textContent = `已选 ${books.length} 本、共 ${total} ${partUnit(main)}，合并后成为 1 本。下面选择保留哪本的书名与阅读进度：`;
  $('#mergeList').innerHTML = books.map((b) => {
    const pct = Math.round(clamp01(b.progress) * 100);
    const n = bookParts(b).length;
    return `<label class="merge-row">
      <input type="radio" name="mergeMain" value="${b.id}" ${b.id === main.id ? 'checked' : ''}>
      <img src="${b.cover || ''}" alt="" draggable="false">
      <div class="merge-main">
        <strong>${escapeHtml(b.title)}</strong>
        <span>${typeText(b)} · ${n} ${partUnit(b)} · ${pct > 0 ? `已读 ${pct}%` : '未读'}</span>
      </div>
    </label>`;
  }).join('');

  $('#mergeOk').textContent = `合并为 1 本`;
  $('#mergeDialog').showModal();
}

async function confirmMergeDialog() {
  const checked = $('#mergeList').querySelector('input[name="mergeMain"]:checked');
  const mainId = checked?.value || pickMainBook(
    [...selected].map((id) => state.books.find((b) => b.id === id)).filter(Boolean),
  )?.id;
  if (!mainId) return;
  const main = state.books.find((b) => b.id === mainId);
  const others = [...selected].filter((id) => id !== mainId);
  if (!main || !others.length) return;

  $('#mergeDialog').close();
  const { n, added } = await mergeInto(mainId, others);
  clearSelection();
  toast(`已合并为《${main.title}》，共 ${bookParts(main).length} ${partUnit(main)}`);
  openMergeResult(mainId, added);
  return n;
}

/* ---------------- 合并结果：按章节区分 ---------------- */

let mergeResultId = null;

/**
 * 合并完成后的结果展示
 * 之前只报总页数 / 文件数，看不出书里到底是哪几章；这里按分段（章 / 册）逐条列出
 * @param {string} bookId 合并后的书
 * @param {string[]} addedIds 本次新并入的分段 id，用于高亮
 */
export function openMergeResult(bookId, addedIds = []) {
  const book = state.books.find((b) => b.id === bookId);
  if (!book) return;
  const dlg = $('#mergeResultDialog');
  if (!dlg) return;

  mergeResultId = bookId;
  const parts = bookParts(book);
  const added = new Set(addedIds);
  const unit = partUnit(book);

  $('#mergeResultLead').innerHTML = `《${escapeHtml(book.title)}》共 <strong>${parts.length} ${unit}</strong>`
    + ` · ${escapeHtml(book.countLabel || '')} · ${fmtBytes(book.size)}，已按顺序排好：`;

  $('#mergeResultList').innerHTML = parts.map((p, i) => {
    const isNew = added.has(p.id);
    return `<li class="${isNew ? 'new' : ''}">
      <em>${i + 1}</em>
      <div class="ch-main">
        <strong>${escapeHtml(partChapterLabel(p, i, book))}</strong>
        <span>${escapeHtml(p.name || '')}${isNew ? ' · 新并入' : ''}</span>
      </div>
      <b>${escapeHtml(p.countLabel || '')}</b>
    </li>`;
  }).join('');

  if (!dlg.open) dlg.showModal();
}

function closeMergeResult() {
  const dlg = $('#mergeResultDialog');
  if (dlg?.open) dlg.close();
}

document.addEventListener('click', (e) => {
  // 菜单内容被替换后，原点击目标已脱离文档，不能据此判断「点在外面」
  if (!(e.target instanceof Node) || !document.contains(e.target)) return;
  if (!e.target.closest('#ctxMenu')) closeCtx();
});
document.addEventListener('scroll', closeCtx, true);
window.addEventListener('resize', closeCtx);

/* ---------------- 进度与删除 ---------------- */

export async function resetProgress(id) {
  const book = state.books.find((b) => b.id === id);
  if (!book) return;
  book.progress = 0;
  book.loc = null;
  book.finished = false;
  await db.putBook(book);
  renderAll();
  toast('已标记为未读');
}

/* ---------------- 删除 ----------------
   先摘书目记录，文件留 15 秒再真删：
   记录立刻从书架消失，期间点「撤销」把记录放回去，文件原封不动。
   文件索引这时还没动，所以导入结束的 sweep 也不会误清它们。
--------------------------------------------------------- */

const PURGE_DELAY = 15000;
const pendingPurge = new Map();   // key → { books, ids, timer }

function schedulePurge(books) {
  const ids = [...new Set(books.flatMap((b) => bookParts(b).map((p) => p.id)))];
  const key = books.map((b) => b.id).join(',');
  const timer = setTimeout(async () => {
    pendingPurge.delete(key);
    for (const id of ids) {
      try { await db.deleteFile(id); } catch { /* 单个失败不影响其它 */ }
    }
  }, PURGE_DELAY);
  pendingPurge.set(key, { books, ids, timer });
  return key;
}

async function undoPurge(key) {
  const job = pendingPurge.get(key);
  if (!job) return false;
  clearTimeout(job.timer);
  pendingPurge.delete(key);
  for (const b of job.books) await db.putBook(b);
  state.books = await db.allBooks();
  renderAll();
  return true;
}

export async function removeBook(id) {
  const book = state.books.find((b) => b.id === id);
  if (!book) return;
  const ok = await confirmDialog({
    title: '删除这本书？',
    text: `《${book.title}》和它的阅读进度会一起从本机删除。删除后还有 15 秒可以撤销。`,
    ok: '删除',
  });
  if (!ok) return;
  // 确认期间这本书可能已经不在了
  if (!state.books.some((b) => b.id === id)) return;

  await db.deleteBookRecord(id);
  state.books = state.books.filter((b) => b.id !== id);
  // 删空了就退出多选，别把操作条留在那儿
  if (!selected.size) clearSelection();
  renderAll();

  const key = schedulePurge([book]);
  toast(`已删除《${book.title}》`, '', {
    label: '撤销',
    duration: PURGE_DELAY,
    onClick: () => undoPurge(key),
  });
}

/**
 * 批量删除选中的书
 * 书目记录一次摘掉（很快），文件等 15 秒撤销窗口过去再删。
 */
export async function removeSelected() {
  const books = [...selected]
    .map((id) => state.books.find((b) => b.id === id))
    .filter(Boolean);
  if (!books.length) return;

  const files = books.reduce((sum, b) => sum + bookParts(b).length, 0);
  const size = books.reduce((sum, b) => sum + (b.size || 0), 0);
  const names = books.slice(0, 3).map((b) => `《${b.title}》`).join('、');
  const more = books.length > 3 ? ` 等 ${books.length} 本` : '';

  const ok = await confirmDialog({
    title: `删除这 ${books.length} 本书？`,
    text: `${names}${more}，共 ${files} ${partUnit(books[0])}、${fmtBytes(size)}，`
      + '连同阅读进度一起从本机删除。删除后还有 15 秒可以撤销。',
    ok: `删除 ${books.length} 本`,
  });
  if (!ok) return;

  // 确认期间状态变了（比如别处删了一本）就按最新的来
  const alive = books.filter((b) => state.books.some((x) => x.id === b.id));
  if (!alive.length) return;

  const btn = $('#selectDelete');
  if (btn) btn.disabled = true;

  await Promise.all(alive.map((b) => db.deleteBookRecord(b.id).catch((err) => {
    console.warn('删除失败', b.title, err);
  })));

  const gone = new Set(alive.map((b) => b.id));
  state.books = state.books.filter((b) => !gone.has(b.id));
  clearSelection();
  renderAll();

  const key = schedulePurge(alive);
  toast(`已删除 ${alive.length} 本（${fmtBytes(size)}）`, '', {
    label: '撤销',
    duration: PURGE_DELAY,
    onClick: () => undoPurge(key),
  });
}

/* ---------------- 详情 ---------------- */

let detailId = null;

export function openDetail(id) {
  const book = state.books.find((b) => b.id === id);
  if (!book) return;
  detailId = id;
  const pct = Math.round(clamp01(book.progress) * 100);

  $('#detailCover').src = book.cover || '';
  $('#detailTitle').textContent = book.title;
  $('#detailAuthor').textContent = book.author || '未标注作者';
  $('#detailPct').textContent = `${pct}%`;
  $('#detailBar').style.width = `${pct}%`;
  const parts = bookParts(book);
  $('#detailMeta').innerHTML = `
    <div><dt>类型</dt><dd>${typeText(book)}</dd></div>
    <div><dt>体量</dt><dd>${countText(book)}</dd></div>
    <div><dt>文件大小</dt><dd>${fmtBytes(book.size)}</dd></div>
    <div><dt>格式</dt><dd>${(book.ext || '').toUpperCase()}</dd></div>
    <div><dt>导入时间</dt><dd>${fmtDate(book.addedAt)}</dd></div>
    <div><dt>最近阅读</dt><dd>${book.lastReadAt ? fmtDate(book.lastReadAt) : '还没读过'}</dd></div>
    <div><dt>累计阅读</dt><dd>${fmtDuration(book.timeTotal)}</dd></div>`;

  // 多分段的书按章节区分展示，而不是只报「共 N 页」
  const chapters = $('#detailChapters');
  if (chapters) {
    if (parts.length > 1) {
      const unit = partUnit(book);
      const per = book.type === 'comic' ? '页' : '章';
      chapters.hidden = false;
      chapters.innerHTML = `
        <div class="dc-head"><span>章节</span><span>${parts.length} ${unit} · ${book.count} ${per}</span></div>
        <ul class="dc-list">${parts.map((p, i) => `<li>
          <em>${i + 1}</em>
          <span class="dc-name">${escapeHtml(partChapterLabel(p, i, book))}</span>
          <b>${escapeHtml(p.countLabel || '')}</b>
        </li>`).join('')}</ul>`;
    } else {
      chapters.hidden = true;
      chapters.innerHTML = '';
    }
  }

  $('#detailRead').textContent = pct > 0 ? '继续阅读' : '开始阅读';
  // 换封面只对漫画开放（epub/txt/pdf 没有多余的图可选）
  $('#detailCoverChange').hidden = book.type !== 'comic';
  $('#detailDialog').showModal();
}

/* ---------------- 编辑书名/作者 ---------------- */

let editId = null;

export function openEdit(id) {
  const book = state.books.find((b) => b.id === id);
  if (!book) return;
  editId = id;
  $('#editTitle').value = book.title || '';
  $('#editAuthor').value = book.author || '';
  $('#editDialog').showModal();
  // 打开后全选书名，方便直接重打
  requestAnimationFrame(() => $('#editTitle').select());
}

async function saveEdit() {
  const book = state.books.find((b) => b.id === editId);
  if (!book) { $('#editDialog').close(); return; }

  const title = $('#editTitle').value.trim().replace(/\s+/g, ' ');
  const author = $('#editAuthor').value.trim().replace(/\s+/g, ' ');
  if (!title) { toast('书名不能为空'); $('#editTitle').focus(); return; }

  const oldTitle = book.title;
  if (title === oldTitle && author === (book.author || '')) {
    $('#editDialog').close();
    return;
  }

  book.title = title;
  book.author = author;
  // 系列分组信息从书名派生，改名后重新推导，后续「合并到另一本」才能按新名字配对
  if (book.series) book.series = { ...seriesInfo(title) };
  // 占位封面由书名生成，改名后重新生成一张；真实封面不动
  // coverDerived 可能没传到书上（旧数据），占位封面本身是 svg data URI，一并识别
  if (book.coverDerived || /^data:image\/svg/.test(book.cover || '')) {
    book.cover = fallbackCover(title, (book.ext || '').toUpperCase());
  }
  await db.putBook(book);
  editId = null;
  $('#editDialog').close();
  renderAll();
  toast(`已保存《${title}》`);
}

/* ---------------- 换封面（书内选图） ---------------- */

let coverId = null;

const IMG_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };

export async function openCoverPicker(id) {
  const book = state.books.find((b) => b.id === id);
  if (!book || book.type !== 'comic') return;
  coverId = id;

  // 多分段：每话的封面就是现成的候选；单文件漫画：解包取前 12 页
  const parts = bookParts(book);
  let imgs = parts.filter((p) => p.cover).map((p, i) => ({ src: p.cover, label: partChapterLabel(p, i, book) }));
  if (!imgs.length && parts[0]) {
    try {
      const blob = await db.getFile(parts[0].id);
      if (blob) {
        const zip = await JSZip.loadAsync(blob);
        const names = Object.keys(zip.files)
          .filter((n) => !zip.files[n].dir && /\.(jpe?g|png|webp|gif|avif)$/i.test(n))
          .sort(naturalCompare)
          .slice(0, 12);
        const urls = [];
        for (const n of names) {
          const ext = n.split('.').pop().toLowerCase();
          const b64 = await zip.files[n].async('base64');
          urls.push(`data:${IMG_MIME[ext] || 'image/jpeg'};base64,${b64}`);
        }
        imgs = urls.map((src, i) => ({ src, label: `第 ${i + 1} 页` }));
      }
    } catch { /* 解包失败按无候选处理 */ }
  }

  if (!imgs.length) { toast('这本书里没有可用的图片'); return; }

  $('#coverLead').textContent = `从《${book.title}》里挑一张图当封面，共 ${imgs.length} 张候选。`;
  const grid = $('#coverGrid');
  grid.innerHTML = imgs.map((im, i) => `
    <button data-cover="${i}" title="${escapeHtml(im.label)}">
      <img src="${im.src}" alt="" loading="lazy">
    </button>`).join('');
  grid.onclick = async (e) => {
    const btn = e.target.closest('button[data-cover]');
    if (!btn) return;
    const pick = imgs[Number(btn.dataset.cover)];
    const b2 = state.books.find((x) => x.id === coverId);
    if (b2 && pick) {
      b2.cover = pick.src;
      b2.coverDerived = false;
      await db.putBook(b2);
      renderAll();
      toast(`封面已更新为「${pick.label}」`);
    }
    coverId = null;
    $('#coverDialog').close();
  };

  $('#coverDialog').showModal();
}

/* ---------------- 事件绑定 ---------------- */

export function initLibrary() {
  const shelf = $('#shelf');

  shelf.addEventListener('click', (e) => {
    // 触屏长按刚弹出菜单时，松手会补一个 click，忽略它
    if (Date.now() < suppressClickUntil) return;

    const card = e.target.closest('.card');
    if (!card) return;

    const id = card.dataset.id;
    if (e.metaKey || e.ctrlKey) { toggleSelect(id); return; }
    if (e.shiftKey) { selectRange(id); return; }
    // 已在多选状态：单击即切换，双击才打开
    if (selectMode || selected.size) { toggleSelect(id); return; }
    emit('open-book', id);
  });

  // 多选状态下，双击卡片直接打开并退出选择
  shelf.addEventListener('dblclick', (e) => {
    if (!selectMode && !selected.size) return;
    const card = e.target.closest('.card');
    if (!card) return;
    clearSelection();
    emit('open-book', card.dataset.id);
  });

  shelf.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    suppressClickUntil = Date.now() + 500;
    openCtxMenu(e.clientX, e.clientY, card.dataset.id);
  });

  shelf.addEventListener('keydown', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (selectMode || selected.size) toggleSelect(card.dataset.id);
      else emit('open-book', card.dataset.id);
    }
  });

  /* ---------------- 选择操作条 ---------------- */

  $('#btnSelect')?.addEventListener('click', toggleSelectMode);
  $('#btnSelectAll')?.addEventListener('click', toggleSelectAll);
  $('#selectMerge')?.addEventListener('click', openMergeDialog);
  $('#selectDelete')?.addEventListener('click', removeSelected);
  $('#selectCancel')?.addEventListener('click', clearSelection);
  $('#selectAll')?.addEventListener('click', toggleSelectAll);

  initDragSelect(shelf);

  $('#mergeCancel')?.addEventListener('click', () => $('#mergeDialog').close());
  $('#mergeOk')?.addEventListener('click', confirmMergeDialog);
  $('#mergeDialog')?.addEventListener('cancel', (e) => {
    e.preventDefault();
    $('#mergeDialog').close();
  });

  $('#mergeResultClose')?.addEventListener('click', closeMergeResult);
  $('#mergeResultRead')?.addEventListener('click', () => {
    const id = mergeResultId;
    closeMergeResult();
    if (id) emit('open-book', id);
  });
  $('#mergeResultDialog')?.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeMergeResult();
  });

  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    if (!$('#reader')?.hidden) return;
    const tag = document.activeElement?.tagName || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;

    if (e.key === 'Escape' && (selectMode || selected.size)) {
      e.preventDefault();
      clearSelection();
      return;
    }
    // 多选状态下按 Delete / Backspace 直接走批量删除（会先弹确认）
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size) {
      e.preventDefault();
      removeSelected();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a'
      && state.view === 'library' && !selected.size) {
      const visible = visibleBooks();
      if (!visible.length) return;
      e.preventDefault();
      selectMode = true;
      visible.forEach((b) => selected.add(b.id));
      anchorId = visible[0].id;
      syncSelectionDom();
      syncSelectBar();
    }
  });

  $('#recentList').addEventListener('click', (e) => {
    const item = e.target.closest('.recent-item');
    if (item) emit('open-book', item.dataset.id);
  });
  $('#recentList').addEventListener('keydown', (e) => {
    const item = e.target.closest('.recent-item');
    if (item && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      emit('open-book', item.dataset.id);
    }
  });

  $('#filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    $$('#filters .chip').forEach((c) => {
      c.classList.toggle('active', c === chip);
      c.setAttribute('aria-selected', String(c === chip));
    });
    renderShelf();
  });

  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value;
    renderShelf();
  });

  $('#sortBy').addEventListener('change', (e) => {
    state.sort = e.target.value;
    renderShelf();
  });

  $('#detailRead').addEventListener('click', () => {
    const id = detailId;
    $('#detailDialog').close();
    if (id) emit('open-book', id);
  });

  $('#detailReset').addEventListener('click', async () => {
    if (!detailId) return;
    await resetProgress(detailId);
    $('#detailDialog').close();
  });

  $('#detailDelete').addEventListener('click', async () => {
    const id = detailId;
    $('#detailDialog').close();
    if (id) await removeBook(id);
  });

  $('#detailEdit').addEventListener('click', () => {
    const id = detailId;
    $('#detailDialog').close();
    if (id) openEdit(id);
  });

  $('#detailCoverChange').addEventListener('click', () => {
    const id = detailId;
    $('#detailDialog').close();
    if (id) openCoverPicker(id);
  });

  $('#coverCancel').addEventListener('click', () => {
    coverId = null;
    $('#coverDialog').close();
  });

  $('#editForm').addEventListener('submit', (e) => {
    e.preventDefault();
    saveEdit();
  });

  $('#editCancel').addEventListener('click', () => {
    editId = null;
    $('#editDialog').close();
  });
}

export function setEmptyImportHandler(fn) {
  $('#btnImportEmpty')?.addEventListener('click', fn);
}
