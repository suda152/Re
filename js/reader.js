/* ===========================================================
   阅读器外壳：工具栏、目录、设置、进度、快捷键
   =========================================================== */

import { $, clamp, debounce, escapeHtml, toast } from './util.js';
import { db } from './db.js';
import { state, prefs } from './state.js';
import { EpubReader } from './reader-epub.js';
import { ComicReader } from './reader-comic.js';
import { TYPE_LABEL } from './import.js';
import { bookParts } from './parts.js';
import { renderAll } from './library.js';
import { platform, isWideLandscape } from './platform.js';
import { native, holdAwake } from './native.js';
import { startTracking, stopTracking } from './tracker.js';

const THEMES = [['light', '纸白'], ['sepia', '米黄'], ['dark', '深色'], ['black', '纯黑']];
const FONTS = [['serif', '宋体'], ['sans', '黑体'], ['kai', '楷体']];
const LINE_HEIGHTS = [['1.6', '紧凑'], ['1.85', '标准'], ['2.1', '宽松']];
const WIDTHS = [['narrow', '窄'], ['normal', '适中'], ['wide', '宽']];

let engine = null;
let book = null;
let localPrefs = null;
let panel = null;
let idleTimer = null;
let scrubbing = false;
/** 触屏轻扫状态；suppressStageClickUntil 用来吞掉手势后补发的 click */
let swipeState = null;
let suppressStageClickUntil = 0;

const el = () => $('#reader');

/* ---------------- PDF（交给浏览器内置查看器） ---------------- */

class PdfReader {
  constructor({ book: b, file, onUpdate }) {
    this.book = b;
    this.file = file;
    this.onUpdate = onUpdate;
    this.total = 0;
    this.percent = b.progress || 0;
  }

  async mount(host) {
    this.url = URL.createObjectURL(this.file);
    host.innerHTML = `<div class="pdf-wrap"><iframe src="${this.url}#view=FitH" title="PDF 预览"></iframe></div>`;
    this.onUpdate({
      percent: this.percent,
      label: 'PDF · 使用内置查看器',
      canPrev: false,
      canNext: false,
      loc: null,
    });
  }

  next() {
    const f = this.url && this.file;
    toast(f ? 'PDF 请在页面内滚动阅读' : 'PDF 无法翻页');
  }

  prev() { this.next(); }
  seek() { /* 浏览器内置查看器不暴露页码 */ }
  updatePrefs() { }
  applyPrefs() { }
  getToc() { return []; }
  goTo() { }
  resize() { }
  get loc() { return null; }
  get isZoomed() { return false; }
  destroy() {
    if (this.url) URL.revokeObjectURL(this.url);
  }
}

/* ---------------- 打开 / 关闭 ---------------- */

export async function openBook(id) {
  if (engine) await closeReader();

  const found = state.books.find((b) => b.id === id);
  book = found || await db.getBook(id);
  if (!book) return toast('找不到这本书', 'err');

  const isComic = book.type === 'comic';
  const metas = bookParts(book);
  const parts = [];
  let missing = 0;

  if (isComic) {
    // 漫画改成按章取文件：300 章的书不会在打开时把所有 CBZ 都读进内存
    for (const meta of metas) parts.push({ meta });
  } else {
    for (const meta of metas) {
      const file = await db.getFile(meta.id);
      if (file) parts.push({ meta, file });
      else missing++;
    }
    if (!parts.length) return toast('这本书的文件已丢失，请重新导入', 'err');
    if (missing) toast(`有 ${missing} 个分段文件缺失，已跳过`, 'err');
  }
  const base = isComic ? prefs.comic : prefs.epub;
  localPrefs = { ...base, ...(book.rprefs || {}) };
  if (!localPrefs.theme) localPrefs.theme = isComic ? 'dark' : 'light';

  // 第一次在平板上打开：横屏漫画默认双页、竖屏正文收窄版心
  // 只影响「从没在这台设备上读过」的书，用户改过就尊重用户
  if (!book.rprefs && platform.touch && platform.tablet) {
    if (isComic && platform.orientation === 'landscape' && prefs.device?.landscapeDouble) {
      localPrefs.mode = 'double';
    }
    if (!isComic && platform.orientation === 'portrait' && localPrefs.width === 'normal') {
      localPrefs.width = 'narrow';
    }
  }

  const reader = el();
  reader.hidden = false;
  reader.setAttribute('aria-hidden', 'false');
  setReaderTheme(localPrefs.theme);
  $('#readerTitle').textContent = book.title;
  const seg = parts.length > 1
    ? ` · ${parts.length} ${isComic ? '章' : '册'}`
    : '';
  $('#readerMeta').textContent = `${TYPE_LABEL[book.type] || '书籍'}${book.author ? ` · ${book.author}` : ''}${seg}`;
  setPanel(null);
  wake();

  const stage = $('#readerStage');
  stage.innerHTML = '';

  const onUpdate = (u) => paint(u);
  try {
    if (book.type === 'comic') {
      engine = new ComicReader({
        book, parts, prefs: localPrefs, onUpdate,
        loadPart: (meta) => db.getFile(meta.id),
      });
    } else if (book.type === 'pdf') engine = new PdfReader({ book, file: parts[0].file, prefs: localPrefs, onUpdate });
    else engine = new EpubReader({ book, parts, prefs: localPrefs, onUpdate });
    await engine.mount(stage);
  } catch (err) {
    console.error(err);
    toast(`打开失败：${err.message || '文件损坏'}`, 'err');
    await closeReader();
    return;
  }

  book.isNew = false;
  book.lastReadAt = Date.now();
  await db.putBook(book);

  // 打开即恢复上次位置
  if (engine.loc) {
    book.loc = engine.loc;
    book.progress = book.progress || 0;
  }

  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onResize);
  stage.addEventListener('click', onStageClick);
  stage.addEventListener('pointerdown', onSwipeStart, { passive: true });
  stage.addEventListener('pointerup', onSwipeEnd, { passive: true });
  stage.addEventListener('pointercancel', onSwipeCancel, { passive: true });
  document.addEventListener('mousemove', onMove);
  reader.addEventListener('click', onChromeClick);
  $('#readerPanel').addEventListener('click', onPanelClick);

  const slider = $('#readerSlider');
  slider.addEventListener('input', () => {
    scrubbing = true;
    $('#readerPct').textContent = `${Math.round(Number(slider.value) / 10)}%`;
  });
  slider.addEventListener('change', () => {
    scrubbing = false;
    engine?.seek(Number(slider.value) / 1000);
  });
  document.addEventListener('fullscreenchange', onFsChange);

  // 原生壳：阅读时全屏 + 常亮（浏览器里是空操作）
  native.immersive(true);
  if (prefs.device?.keepAwake !== false) holdAwake(true);

  // 阅读时长追踪：页面可见时每 15 秒记一次
  startTracking(book);

  requestAnimationFrame(() => reader.classList.remove('opening'));
}

export async function closeReader() {
  if (!engine) return;
  saveNow();
  await stopTracking();
  engine.destroy();
  engine = null;

  document.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('resize', onResize);
  const stage = $('#readerStage');
  stage.removeEventListener('click', onStageClick);
  stage.removeEventListener('pointerdown', onSwipeStart);
  stage.removeEventListener('pointerup', onSwipeEnd);
  stage.removeEventListener('pointercancel', onSwipeCancel);
  swipeState = null;
  document.removeEventListener('mousemove', onMove);
  el().removeEventListener('click', onChromeClick);
  $('#readerPanel').removeEventListener('click', onPanelClick);
  document.removeEventListener('fullscreenchange', onFsChange);
  clearTimeout(idleTimer);

  native.immersive(false);
  holdAwake(false);

  const reader = el();
  reader.hidden = true;
  reader.setAttribute('aria-hidden', 'true');
  chromeHidden = false;
  reader.classList.remove('idle');
  setPanel(null);
  $('#readerStage').innerHTML = '';
  book = null;
  localPrefs = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});

  renderAll();
}

/* ---------------- 进度 ---------------- */

const saveSoon = debounce(() => { saveNow(); }, 600);

function saveNow() {
  if (!book) return;
  db.putBook({ ...book }).catch(() => {});
}

function paint(u) {
  if (!u) return;
  const pct = clamp(u.percent, 0, 1);
  $('#readerPage').textContent = u.label || '';
  $('#readerPct').textContent = `${Math.round(pct * 100)}%`;
  if (!scrubbing) $('#readerSlider').value = String(Math.round(pct * 1000));
  const prevBtn = document.querySelector('[data-r="prev"]');
  const nextBtn = document.querySelector('[data-r="next"]');
  if (prevBtn) prevBtn.disabled = !u.canPrev;
  if (nextBtn) nextBtn.disabled = !u.canNext;

  if (book) {
    book.progress = pct;
    book.loc = u.loc || book.loc;
    book.finished = pct >= 0.995;
    saveSoon();
  }
  if (panel === 'toc') markActiveToc();
}

/* ---------------- 工具条 ---------------- */

// 工具条是否收起。不能用 classList.contains('idle') 反推状态：
// 触摸点击会先产生一个合成的 mousemove，onMove 里 wake() 先把 idle 摘掉，
// 紧接着的 click 就以为「本来就没收起」，又把它藏回去——平板上一按就闪一下。
let chromeHidden = false;

function hideChrome() {
  const reader = el();
  if (!reader) return;
  chromeHidden = true;
  reader.classList.add('idle');
  clearTimeout(idleTimer);
}

function wake() {
  const reader = el();
  if (!reader) return;
  chromeHidden = false;
  reader.classList.remove('idle');
  clearTimeout(idleTimer);
  if (!panel) {
    idleTimer = setTimeout(() => {
      if (!panel && engine) hideChrome();
    }, 3200);
  }
}

let moveTick = 0;
function onMove(e) {
  if (panel) return;
  // 触摸合成的 mousemove 不算「鼠标移动」，否则手指一碰就把工具条状态搅乱
  if (e?.sourceCapabilities?.firesTouchEvents) return;
  const now = Date.now();
  if (now - moveTick < 120) return;
  moveTick = now;
  wake();
}

function toggleChrome() {
  if (chromeHidden) wake();
  else hideChrome();
}

function onChromeClick(e) {
  const btn = e.target.closest('[data-r]');
  if (!btn) return;
  e.stopPropagation();
  const act = btn.dataset.r;
  if (act === 'close') closeReader();
  else if (act === 'prev') engine?.prev();
  else if (act === 'next') engine?.next();
  else if (act === 'toc') setPanel(panel === 'toc' ? null : 'toc');
  else if (act === 'settings') setPanel(panel === 'settings' ? null : 'settings');
  else if (act === 'fullscreen') toggleFullscreen();
  else if (act === 'panel-close') setPanel(null);
}

function onFsChange() {
  requestAnimationFrame(() => engine?.resize?.());
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => toast('当前环境不支持全屏'));
}

/* ---------------- 点击分区 ---------------- */

function onStageClick(e) {
  if (Date.now() < suppressStageClickUntil) return;
  if (e.target.closest('a[data-href]')) return;
  if (window.getSelection()?.toString()) return;
  if (panel) { setPanel(null); return; }
  if (chromeHidden) { wake(); return; }
  if (engine?.isZoomed) return;

  const scrollMode = book?.type === 'comic' && engine?.mode === 'scroll';
  if (scrollMode) { toggleChrome(); return; }

  // 日漫（RTL）阅读方向从右往左：右侧点按=上一页，左侧=下一页
  const rtl = book?.type === 'comic' && localPrefs?.rtl;
  const x = e.clientX / window.innerWidth;
  if (rtl) {
    if (x > 0.74) { engine?.prev(); wake(); }
    else if (x < 0.26) { engine?.next(); wake(); }
    else toggleChrome();
  } else {
    if (x < 0.26) { engine?.prev(); wake(); }
    else if (x > 0.74) { engine?.next(); wake(); }
    else toggleChrome();
  }
}

/* ---------------- 触屏轻扫翻页 ---------------- */

const SWIPE_MIN = 56;   // 横向位移阈值
const SWIPE_MAX_Y = 40; // 纵向容忍，超过当滚动
const EDGE = 24;        // 边缘留给系统返回手势

function swipeAllowed(e) {
  if (!engine || !prefs.device?.swipe) return false;
  if (e.pointerType === 'mouse') return false;
  if (panel || engine.isZoomed) return false;
  if (book?.type === 'comic' && engine.mode === 'scroll') return false;
  return true;
}

function onSwipeStart(e) {
  swipeState = null;
  if (!swipeAllowed(e)) return;
  const x = e.clientX;
  const left = EDGE + (platform.safe.left || 0);
  const right = window.innerWidth - EDGE - (platform.safe.right || 0);
  // 从屏幕边缘起手交给系统，不翻页
  if (x < left || x > right) return;
  swipeState = { x0: x, y0: e.clientY, t: Date.now(), id: e.pointerId };
}

function onSwipeCancel() {
  swipeState = null;
}

function onSwipeEnd(e) {
  const s = swipeState;
  swipeState = null;
  if (!s || s.id !== e.pointerId || !engine) return;

  const dx = e.clientX - s.x0;
  const dy = e.clientY - s.y0;
  if (Math.abs(dx) < SWIPE_MIN) return;
  if (Math.abs(dy) > SWIPE_MAX_Y && Math.abs(dy) > Math.abs(dx) * 0.6) return;
  if (Date.now() - s.t > 900) return;

  const rtl = book?.type === 'comic' && localPrefs?.rtl;
  const forward = dx < 0; // 左滑 = 往后翻（左→右阅读）
  if (forward) { if (rtl) engine.prev(); else engine.next(); }
  else if (rtl) engine.next();
  else engine.prev();

  suppressStageClickUntil = Date.now() + 420;
  wake();
}

/* ---------------- 目录 ---------------- */

function setPanel(name) {
  const p = $('#readerPanel');
  panel = name;
  syncRail();
  if (!name) {
    p.classList.remove('open');
    p.setAttribute('aria-hidden', 'true');
    wake();
    return;
  }
  p.classList.add('open');
  p.setAttribute('aria-hidden', 'false');
  clearTimeout(idleTimer);
  chromeHidden = false;
  el().classList.remove('idle');
  $('#panelTitle').textContent = name === 'toc' ? '目录' : '阅读设置';
  $('#panelBody').scrollTop = 0;
  if (name === 'toc') renderToc();
  else renderSettingsPanel();
}

function renderToc() {
  const body = $('#panelBody');
  const list = engine?.getToc?.() || [];
  if (!list.length) {
    body.innerHTML = '<p class="toc-empty">这本书没有可用的目录信息。<br>可以用底部进度条跳转，或直接翻页。</p>';
    return;
  }
  body.innerHTML = `<ul class="toc-list">${list.map((t, i) => `
    <li><button class="toc-item${t.chapter ? ' chapter' : ''}" data-toc="${i}">
      <span class="idx">${i + 1}</span>
      <span class="txt lvl" style="--lvl:${t.level || 0}">${escapeHtml(t.label || `第 ${i + 1} 节`)}</span>
      ${t.sub ? `<span class="sub">${escapeHtml(t.sub)}</span>` : ''}
    </button></li>`).join('')}</ul>`;
  markActiveToc();
}

function markActiveToc() {
  const items = Array.from($('#panelBody').querySelectorAll('.toc-item'));
  if (!items.length || !engine) return;
  const list = engine.getToc();
  const cur = engine.loc;
  const chapter = cur?.chapter;
  const page = cur?.page;
  items.forEach((it, i) => {
    const t = list[i];
    // 漫画合并书里的「章」条目带页码范围，落在区间内就算当前章
    const on = t && t.range
      ? page >= t.range[0] && page <= t.range[1]
      : chapter != null
        ? t && t.index === chapter
        : t && t.index === page;
    it.classList.toggle('active', !!on);
  });
}

function onPanelClick(e) {
  const tocBtn = e.target.closest('[data-toc]');
  if (tocBtn && engine) {
    const list = engine.getToc();
    const item = list[Number(tocBtn.dataset.toc)];
    engine.goTo(item);
    setPanel(null);
    return;
  }
  const setBtn = e.target.closest('[data-set]');
  if (setBtn) {
    const key = setBtn.dataset.set;
    let val = setBtn.dataset.val;
    if (key === 'fontSize') {
      applySetting(key, clamp((localPrefs.fontSize || 19) + Number(val), 14, 32));
      return;
    }
    if (key === 'lineHeight') val = Number(val);
    if (key === 'rtl') val = val === '1';
    applySetting(key, val);
  }
}

/* ---------------- 设置面板 ---------------- */

function renderSettingsPanel() {
  if (!engine || !localPrefs) return;
  const body = $('#panelBody');
  const isComic = book.type === 'comic';
  const isPdf = book.type === 'pdf';

  if (isPdf) {
    body.innerHTML = `<div class="set-group">
      <div class="set-label"><span>PDF 阅读</span></div>
      <p class="set-tip">PDF 使用浏览器内置查看器渲染，可滚动、缩放与搜索文字。翻页与进度记录暂不支持，建议全屏阅读。</p>
    </div>`;
    return;
  }

  if (isComic) {
    body.innerHTML = `
      <div class="set-group">
        <div class="set-label"><span>阅读模式</span></div>
        <div class="set-row">
          ${[['single', '单页'], ['double', '双页对开'], ['scroll', '纵向条漫']].map(([v, l]) =>
            `<button class="set-btn ${localPrefs.mode === v ? 'active' : ''}" data-set="mode" data-val="${v}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="set-group">
        <div class="set-label"><span>画面适应</span></div>
        <div class="set-row">
          ${[['contain', '适高'], ['width', '适宽'], ['original', '原始尺寸']].map(([v, l]) =>
            `<button class="set-btn ${localPrefs.fit === v ? 'active' : ''}" data-set="fit" data-val="${v}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="set-group">
        <div class="set-label"><span>翻页方向</span></div>
        <div class="set-row">
          <button class="set-btn ${!localPrefs.rtl ? 'active' : ''}" data-set="rtl" data-val="0">左 → 右</button>
          <button class="set-btn ${localPrefs.rtl ? 'active' : ''}" data-set="rtl" data-val="1">右 → 左（日漫）</button>
        </div>
      </div>
      <div class="set-group">
        <div class="set-label"><span>底色</span></div>
        <div class="swatches">
          ${THEMES.map(([v, l]) => `<button class="swatch ${localPrefs.theme === v ? 'active' : ''}" data-t="${v}" data-set="theme" data-val="${v}">${l}</button>`).join('')}
        </div>
      </div>
      <p class="set-tip">双指或 Ctrl + 滚轮缩放；放大后拖动画面平移。单页模式下滚轮可直接翻页。</p>`;
    return;
  }

  body.innerHTML = `
    <div class="set-group">
      <div class="set-label"><span>字号</span><em>${localPrefs.fontSize || 19}px</em></div>
      <div class="stepper">
        <button data-set="fontSize" data-val="-1">−</button>
        <div class="val">${localPrefs.fontSize || 19}</div>
        <button data-set="fontSize" data-val="1">＋</button>
      </div>
    </div>
    <div class="set-group">
      <div class="set-label"><span>行距</span></div>
      <div class="set-row">
        ${LINE_HEIGHTS.map(([v, l]) =>
          `<button class="set-btn ${String(localPrefs.lineHeight) === v ? 'active' : ''}" data-set="lineHeight" data-val="${v}">${l}</button>`).join('')}
      </div>
    </div>
    <div class="set-group">
      <div class="set-label"><span>字体</span></div>
      <div class="set-row">
        ${FONTS.map(([v, l]) =>
          `<button class="set-btn ${localPrefs.font === v ? 'active' : ''}" data-set="font" data-val="${v}">${l}</button>`).join('')}
      </div>
    </div>
    <div class="set-group">
      <div class="set-label"><span>背景</span></div>
      <div class="swatches">
        ${THEMES.map(([v, l]) => `<button class="swatch ${localPrefs.theme === v ? 'active' : ''}" data-t="${v}" data-set="theme" data-val="${v}">${l}</button>`).join('')}
      </div>
    </div>
    <div class="set-group">
      <div class="set-label"><span>版心宽度</span></div>
      <div class="set-row">
        ${WIDTHS.map(([v, l]) =>
          `<button class="set-btn ${localPrefs.width === v ? 'active' : ''}" data-set="width" data-val="${v}">${l}</button>`).join('')}
      </div>
    </div>
    <p class="set-tip">左右方向键翻页，Ctrl + 滚轮可快速调整字号。</p>`;
}

function applySetting(key, value) {
  if (!localPrefs || !engine) return;
  localPrefs[key] = value;
  if (key === 'theme') setReaderTheme(value);

  if (book.type === 'comic') engine.updatePrefs({ [key]: value });
  else engine.applyPrefs({ [key]: value });

  book.rprefs = { ...localPrefs };
  saveSoon();

  const body = $('#panelBody');
  const top = body.scrollTop;
  renderSettingsPanel();
  body.scrollTop = top;
}

function setReaderTheme(theme) {
  el().dataset.rtTheme = theme || 'light';
}

/* ---------------- 快捷键 ---------------- */

function onKeyDown(e) {
  if (!engine) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag)) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const comic = book.type === 'comic';
  const rtl = comic && localPrefs?.rtl;

  switch (e.key) {
    case 'Escape':
      if (panel) setPanel(null);
      else closeReader();
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (rtl) engine.prev(); else engine.next();
      wake();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (rtl) engine.next(); else engine.prev();
      wake();
      break;
    case 'PageDown':
    case ' ':
      if (e.shiftKey) { engine.prev(); } else { engine.next(); }
      e.preventDefault();
      wake();
      break;
    case 'PageUp':
      e.preventDefault();
      engine.prev();
      wake();
      break;
    case 't':
    case 'T':
      setPanel(panel === 'toc' ? null : 'toc');
      break;
    case 'f':
    case 'F':
      toggleFullscreen();
      break;
    default:
      break;
  }
}

const resizeEngine = debounce(() => {
  engine?.resize?.();
  syncRail();
}, platform.native ? 200 : 160);

function onResize() {
  resizeEngine();
}

/* ---------------- 平板 / 原生外壳接口 ---------------- */

/** 宽屏横屏时把目录/设置变成常驻侧栏，正文让出位置 */
function syncRail() {
  const reader = el();
  if (!reader) return;
  reader.classList.toggle('rail-open', !!panel && isWideLandscape());
}

/** 系统返回：先关面板，再退阅读器。返回 true 表示这次返回被吃掉了 */
export function handleBack() {
  if (!engine) return false;
  if (panel) {
    setPanel(null);
    return true;
  }
  closeReader();
  return true;
}

export function isReaderOpen() {
  return !!engine;
}

/** 切后台 / 锁屏前立刻落盘，不等 600ms 防抖 */
export function flushProgress() {
  if (engine) saveNow();
}
