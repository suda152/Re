/* ===========================================================
   CBZ / CBR 漫画阅读引擎
   单页 / 双页对开 / 纵向条漫，支持 RTL 与缩放
   =========================================================== */

import { comicEntries } from './import.js';
import { seriesInfo } from './parts.js';
import { clamp, debounce, escapeHtml } from './util.js';

/** 分段在书里的章节名，和书架 / 合并结果用的是同一套说法 */
function chapterLabel(name, bookTitle, i) {
  const raw = String(name || '').replace(/\.[^.]+$/, '');
  const info = seriesInfo(raw);
  const base = String(info.base || raw).trim();
  const title = String(bookTitle || '').trim().toLowerCase();
  const show = info.hasBase && base && base.toLowerCase() !== title;
  return `第 ${i + 1} 章${show ? ` · ${base}` : ''}`;
}

export class ComicReader {
  constructor({ book, parts, prefs, onUpdate, loadPart }) {
    this.book = book;
    this.partsIn = Array.isArray(parts) ? parts : [];
    this.prefs = { ...prefs };
    this.onUpdate = onUpdate;
    /** 按分段取文件；不给就退回 parts 里预置的 file（浏览器单文件场景） */
    this.loadPart = typeof loadPart === 'function' ? loadPart : null;

    this.mode = ['single', 'double', 'scroll'].includes(prefs.mode) ? prefs.mode : 'single';
    this.index = clamp(book.loc?.page ?? 0, 0, 9999999);
    this.total = 0;
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.cache = new Map();
    this.destroyed = false;
    this.scrollRatio = book.loc?.ratio || 0;
    this.loadedOnce = false;
    /** 每一章：{ meta, zip, entries, start, count, label }；zip 只在读到该章时才有 */
    this.groups = [];
  }

  async mount(host) {
    this.host = host;

    // 用导入时数好的页数先拼出页表：打开 300 章的书不必解压任何一个压缩包
    let acc = 0;
    for (const { meta, file } of this.partsIn) {
      const count = Math.max(0, Number(meta.count) || 0);
      this.groups.push({
        meta,
        file: file || null,
        entries: null,
        zip: null,
        loading: null,
        name: meta.name,
        count,
        start: acc,
        label: chapterLabel(meta.name, this.book.title, this.groups.length),
      });
      acc += count;
    }
    this.total = acc;

    // 早期数据没有页数字段：现场解析补一次（新导入的书不会走到这里）
    const unknown = this.groups.filter((g) => !g.count);
    for (const g of unknown) {
      try {
        const grp = await this._ensure(this.groups.indexOf(g));
        g.count = grp.entries.length;
      } catch (err) {
        console.warn('分段解析失败，已跳过：', g.name, err);
      }
    }
    if (unknown.length) this._reindex();

    // 全部解析后仍然没有页数，说明每个包都是空的
    if (!this.total) throw new Error('这本书里没有可显示的图片');
    this.index = clamp(this.index, 0, this.total - 1);
    if (this.mode === 'double') this.index = this.index - (this.index % 2);

    const loc = this.book.loc;
    if (loc && loc.ratio == null && typeof loc.page === 'number' && this.total > 1) {
      this.scrollRatio = clamp(loc.page / (this.total - 1), 0, 1);
    }

    // 只预载当前这一章：读不出来就在这里报错，而不是让用户对着空白页
    await this._ensure(this._locate(this.index).gi);

    await this.build();
  }

  /* ---------------- 分段定位与惰性加载 ---------------- */

  /** 重算每章起始页与总页数；keep={gi,off} 时把当前页重新锚在原来的章内位置 */
  _reindex(keep) {
    let acc = 0;
    for (const g of this.groups) {
      g.start = acc;
      acc += g.count;
    }
    this.total = acc;
    if (keep) {
      const g = this.groups[keep.gi];
      this.index = g
        ? clamp(g.start + Math.min(keep.off, Math.max(0, g.count - 1)), 0, Math.max(0, this.total - 1))
        : 0;
    } else {
      this.index = clamp(this.index, 0, Math.max(0, this.total - 1));
    }
  }

  /** 全局页号 → 第几章 + 章内偏移 */
  _locate(i) {
    const idx = clamp(i, 0, Math.max(0, this.total - 1));
    let lo = 0;
    let hi = this.groups.length - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const g = this.groups[mid];
      if (idx < g.start) hi = mid - 1;
      else if (idx >= g.start + g.count) lo = mid + 1;
      else { hit = mid; break; }
    }
    // 落在空章（页数为 0）之间的边界时，取第一个能容纳它的章
    if (hit < 0) hit = clamp(lo, 0, Math.max(0, this.groups.length - 1));
    const g = this.groups[hit];
    return { gi: hit, g, off: g ? idx - g.start : 0 };
  }

  _ref() {
    const l = this._locate(this.index);
    return { gi: l.gi, off: l.off };
  }

  /** 取到某一章的 zip 与条目；只在这一章真的要被显示时才解压 */
  async _ensure(gi) {
    const g = this.groups[gi];
    if (!g) throw new Error('章节不存在');
    if (g.zip && g.entries) return g;
    if (g.loading) return g.loading;

    g.loading = (async () => {
      const file = g.file || (this.loadPart ? await this.loadPart(g.meta) : null);
      if (!file) throw new Error('文件已丢失');
      const zip = await JSZip.loadAsync(file);
      const entries = comicEntries(zip);
      if (!entries.length) throw new Error('压缩包里没有图片');
      g.zip = zip;
      g.entries = entries;
      g.file = null;
      // 导入时数的页数和实际条目对不上（老数据、非标准包）：就地校正页表
      if (entries.length !== g.count) {
        const keep = this._ref();
        g.count = entries.length;
        this._reindex(keep.gi === gi ? keep : null);
      }
      return g;
    })();

    try {
      return await g.loading;
    } finally {
      g.loading = null;
    }
  }

  /** 只留当前章前后各一章的 zip，其余释放，避免几百章全压在内存里 */
  _evict(centerGi) {
    this.groups.forEach((g, i) => {
      if (!g.zip || Math.abs(i - centerGi) <= 1) return;
      g.zip = null;
      this._dropUrls(i);
    });
  }

  _dropUrls(gi) {
    const g = this.groups[gi];
    if (!g) return;
    const from = g.start;
    const to = g.start + g.count;
    for (const [i, u] of this.cache) {
      if (i < from || i >= to) continue;
      // 条漫里这一页可能还挂着 src，先摘掉再 revoke，免得出现裂图
      const el = this.imgEls?.[i];
      if (el && el.getAttribute('src')) el.removeAttribute('src');
      try { URL.revokeObjectURL(u); } catch { /* ignore */ }
      this.cache.delete(i);
    }
  }

  /* ---------------- DOM ---------------- */

  build() {
    if (this.mode === 'scroll') return this.buildScroll();
    this.buildPaged();
    return Promise.resolve();
  }

  buildPaged() {
    if (this.scroller) {
      this.scroller.removeEventListener('scroll', this.onScroll);
      this.observer?.disconnect();
      this.scroller = null;
    }
    this.host.innerHTML = `<div class="comic-wrap">
      <div class="comic-pages" data-mode="${this.mode}" data-fit="${this.prefs.fit}"></div>
    </div>`;
    this.wrap = this.host.querySelector('.comic-wrap');
    this.pagesEl = this.host.querySelector('.comic-pages');
    this.pagesEl.style.transform = '';
    this.bindPointer();
    this.bindWheel();
    this.renderPaged(true);
  }

  async buildScroll() {
    this.pagesEl = null;
    this.host.innerHTML = `<div class="comic-scroll" data-fit="${this.prefs.fit}"></div>`;
    this.scroller = this.host.querySelector('.comic-scroll');
    this.scroller.innerHTML = Array.from({ length: this.total }, (_, i) =>
      `<img data-i="${i}" alt="第 ${i + 1} 页" draggable="false">`).join('');

    this.imgEls = Array.from(this.scroller.querySelectorAll('img'));
    this.observer?.disconnect();
    this.observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const i = Number(en.target.dataset.i);
        if (en.isIntersecting) this.attachScrollImage(i);
        else this.detachScrollImage(i);
      }
    }, { root: this.scroller, rootMargin: '1600px 0px' });
    this.imgEls.forEach((img) => this.observer.observe(img));

    this.onScroll = debounce(() => this.handleScroll(), 90);
    this.scroller.addEventListener('scroll', this.onScroll, { passive: true });

    // 先量出首页比例，为所有页面预留高度，否则一次性滚动会因图片未加载而跳位
    await this.calibrate();

    requestAnimationFrame(() => {
      if (this.destroyed || !this.scroller) return;
      this.restoreScroll();
      this.handleScroll();
    });
  }

  async calibrate() {
    if (!this.imgEls?.length) return;
    try {
      const url = await this.getUrl(0);
      const probe = new Image();
      probe.src = url;
      await probe.decode();
      if (probe.naturalWidth && probe.naturalHeight) {
        const ar = `${probe.naturalWidth} / ${probe.naturalHeight}`;
        this.imgEls.forEach((el) => { el.style.aspectRatio = ar; });
      }
    } catch { /* 量不到就退回默认 3:4 */ }
    await new Promise((r) => requestAnimationFrame(() => r()));
  }

  restoreScroll() {
    if (!this.scroller) return;
    const max = this.scroller.scrollHeight - this.scroller.clientHeight;
    this.scroller.scrollTop = clamp(this.scrollRatio, 0, 1) * Math.max(0, max);
  }

  async attachScrollImage(i) {
    const img = this.imgEls[i];
    if (!img || img.getAttribute('src')) return;
    try {
      img.src = await this.getUrl(i);
    } catch {
      img.replaceWith(Object.assign(document.createElement('div'), {
        className: 'comic-missing', textContent: `第 ${i + 1} 页读取失败`,
      }));
    }
  }

  detachScrollImage(i) {
    const img = this.imgEls?.[i];
    if (!img || !img.getAttribute('src')) return;
    if (Math.abs(i - this.visibleIndex()) < 8) return;
    img.removeAttribute('src');
  }

  visibleIndex() {
    if (!this.scroller) return 0;
    const mid = this.scroller.scrollTop + this.scroller.clientHeight / 2;
    let lo = 0;
    let hi = this.imgEls.length - 1;
    // 二分查找当前可见页（图片高度顺序递增）
    while (lo < hi) {
      const midI = (lo + hi) >> 1;
      const el = this.imgEls[midI];
      if (el.offsetTop + el.offsetHeight / 2 < mid) lo = midI + 1;
      else hi = midI;
    }
    return lo;
  }

  /* ---------------- 图片地址 ---------------- */

  async getUrl(i) {
    if (this.cache.has(i)) return this.cache.get(i);
    const { gi, off } = this._locate(i);
    const g = await this._ensure(gi);
    const path = g.entries?.[off];
    if (!path) throw new Error('页面缺失');
    const entry = g.zip.file(path);
    if (!entry) throw new Error('页面缺失');
    const blob = await entry.async('blob');
    const url = URL.createObjectURL(blob);
    this.cache.set(i, url);
    this.pruneCache(i);
    this._evict(gi);
    return url;
  }

  pruneCache(center) {
    if (this.mode === 'scroll') return;
    for (const [i, u] of this.cache) {
      if (Math.abs(i - center) > 3) {
        try { URL.revokeObjectURL(u); } catch { /* ignore */ }
        this.cache.delete(i);
      }
    }
  }

  /* ---------------- 分页渲染 ---------------- */

  async renderPaged(first = false) {
    if (!this.pagesEl || this.mode === 'scroll') return;
    const step = this.mode === 'double' ? 2 : 1;
    const idxs = [];
    for (let k = 0; k < step; k++) {
      const i = this.index + k;
      if (i < this.total) idxs.push(i);
    }
    const order = this.prefs.rtl && this.mode === 'double' ? idxs.slice().reverse() : idxs;

    const urls = await Promise.all(order.map((i) => this.getUrl(i).catch(() => '')));
    if (this.destroyed || !this.pagesEl) return;

    this.pagesEl.innerHTML = order.map((i, k) =>
      `<img src="${urls[k]}" alt="第 ${i + 1} 页" draggable="false">`).join('');
    this.pagesEl.dataset.mode = this.mode;
    this.pagesEl.dataset.fit = this.prefs.fit;
    this.applyTransform();
    this.emit();
  }

  /* ---------------- 翻页 ---------------- */

  get step() { return this.mode === 'double' ? 2 : 1; }

  next() {
    if (this.mode === 'scroll') {
      this.scroller.scrollBy({ top: this.scroller.clientHeight * 0.9, behavior: 'smooth' });
      return;
    }
    if (this.index + this.step < this.total) {
      this.index += this.step;
      this.resetZoom();
      this.renderPaged();
    } else {
      this.emit();
    }
  }

  prev() {
    if (this.mode === 'scroll') {
      this.scroller.scrollBy({ top: -this.scroller.clientHeight * 0.9, behavior: 'smooth' });
      return;
    }
    if (this.index - this.step >= 0) {
      this.index -= this.step;
      this.resetZoom();
      this.renderPaged();
    } else {
      this.emit();
    }
  }

  seek(percent) {
    if (this.mode === 'scroll') {
      const max = this.scroller.scrollHeight - this.scroller.clientHeight;
      this.scroller.scrollTop = clamp(percent, 0, 1) * max;
      return;
    }
    let target = Math.round(clamp(percent, 0, 1) * this.total) - 1;
    if (this.mode === 'double') target -= target % 2;
    this.index = clamp(target, 0, this.total - 1);
    this.resetZoom();
    this.renderPaged();
  }

  /**
   * @param {number} i 目标页
   * @param {{exact?:boolean}} [opts] exact=true 时不按对开对齐
   *   （目录跳章时用：宁可让目标页作为左页起一屏，也不退到上一章去配平）
   */
  goToIndex(i, opts = {}) {
    if (this.mode === 'scroll') {
      const el = this.imgEls?.[clamp(i, 0, this.total - 1)];
      el?.scrollIntoView({ block: 'start' });
      return;
    }
    let target = clamp(i, 0, this.total - 1);
    if (this.mode === 'double' && !opts.exact) target -= target % 2;
    this.index = target;
    this.resetZoom();
    this.renderPaged();
  }

  /* ---------------- 缩放 / 拖拽 ---------------- */

  applyTransform() {
    if (!this.pagesEl) return;
    this.pagesEl.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    this.pagesEl.classList.toggle('zoomable', this.scale > 1);
  }

  resetZoom() {
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.applyTransform();
  }

  zoomBy(delta, originX, originY) {
    const prev = this.scale;
    this.scale = clamp(Number((this.scale + delta).toFixed(2)), 1, 5);
    if (this.scale === 1) { this.tx = 0; this.ty = 0; }
    else if (originX != null && this.wrap) {
      const r = this.wrap.getBoundingClientRect();
      const cx = originX - r.left - r.width / 2;
      const cy = originY - r.top - r.height / 2;
      const k = this.scale / prev;
      this.tx -= cx * (k - 1);
      this.ty -= cy * (k - 1);
    }
    this.applyTransform();
  }

  bindWheel() {
    this.onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.zoomBy(e.deltaY > 0 ? -0.2 : 0.2, e.clientX, e.clientY);
        return;
      }
      if (this.scale > 1) {
        // 放大后交给拖拽；滚轮仅平移
        e.preventDefault();
        this.ty -= e.deltaY;
        this.tx -= e.deltaX;
        this.applyTransform();
        return;
      }
      e.preventDefault();
      const now = Date.now();
      if (now - (this._wheelAt || 0) < 280) return;
      this._wheelAt = now;
      if (e.deltaY > 0) this.next();
      else this.prev();
    };
    this.wrap.addEventListener('wheel', this.onWheel, { passive: false });
  }

  bindPointer() {
    let dragging = false;
    let sx = 0;
    let sy = 0;
    let ox = 0;
    let oy = 0;

    this.onPointerDown = (e) => {
      if (this.scale <= 1 || e.button !== 0) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      ox = this.tx; oy = this.ty;
      this.pagesEl.classList.add('dragging');
      this.pagesEl.setPointerCapture?.(e.pointerId);
    };
    this.onPointerMove = (e) => {
      if (!dragging) return;
      this.tx = ox + (e.clientX - sx);
      this.ty = oy + (e.clientY - sy);
      this.applyTransform();
    };
    this.onPointerUp = (e) => {
      if (!dragging) return;
      dragging = false;
      this.pagesEl.classList.remove('dragging');
      try { this.pagesEl.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    };

    this.pagesEl.addEventListener('pointerdown', this.onPointerDown);
    this.pagesEl.addEventListener('pointermove', this.onPointerMove);
    this.pagesEl.addEventListener('pointerup', this.onPointerUp);
    this.pagesEl.addEventListener('pointercancel', this.onPointerUp);
  }

  /* ---------------- 设置 ---------------- */

  updatePrefs(p) {
    const nextMode = p.mode || this.mode;
    const modeChanged = nextMode !== this.mode;
    this.prefs = { ...this.prefs, ...p };

    if (modeChanged) {
      const ratio = this.currentPercent();
      this.scrollRatio = ratio;
      this.mode = nextMode;
      this.cache.forEach((u) => URL.revokeObjectURL(u));
      this.cache.clear();
      if (this.mode !== 'scroll') {
        let target = Math.round(ratio * this.total) - 1;
        if (this.mode === 'double') target -= target % 2;
        this.index = clamp(target, 0, this.total - 1);
      }
      this.build();
      return;
    }

    if (this.mode === 'scroll') {
      this.scroller.dataset.fit = this.prefs.fit;
      return;
    }
    if (this.pagesEl) {
      const fitChanged = this.pagesEl.dataset.fit !== this.prefs.fit;
      this.pagesEl.dataset.fit = this.prefs.fit;
      if (fitChanged) this.renderPaged();
    }
  }

  /* ---------------- 状态 ---------------- */

  currentPercent() {
    if (this.mode === 'scroll') return this.scrollRatio;
    return clamp((this.index + this.step) / this.total, 0, 1);
  }

  handleScroll() {
    if (!this.scroller || !this.imgEls) return;
    const max = this.scroller.scrollHeight - this.scroller.clientHeight;
    this.scrollRatio = max > 0 ? clamp(this.scroller.scrollTop / max, 0, 1) : 0;
    const vi = this.visibleIndex();
    for (let i = 0; i < this.imgEls.length; i++) {
      if (Math.abs(i - vi) > 10) this.detachScrollImage(i);
    }
    this.emitScroll(vi);
  }

  /** 当前页属于哪一章；单文件的书没有「章」的概念，返回空 */
  chapterOf(i) {
    if (this.groups.length < 2) return '';
    const { g } = this._locate(i || 0);
    return g?.label || '';
  }

  emitScroll(vi) {
    const percent = clamp(this.scrollRatio, 0, 1);
    const chap = this.chapterOf(vi);
    this.onUpdate({
      percent,
      label: `${chap ? `${chap} · ` : ''}第 ${(vi || 0) + 1} / ${this.total} 页 · 条漫`,
      canPrev: percent > 0.001,
      canNext: percent < 0.999,
      loc: { page: vi || 0, ratio: this.scrollRatio, mode: 'scroll' },
    });
  }

  emit() {
    const pct = clamp((this.index + this.step) / this.total, 0, 1);
    const chap = this.chapterOf(this.index);
    this.onUpdate({
      percent: pct,
      label: `${chap ? `${chap} · ` : ''}${this.mode === 'double' ? '双页 · ' : ''}${this.index + 1} / ${this.total} 页`,
      canPrev: this.index > 0,
      canNext: this.index + this.step < this.total,
      loc: { page: this.index, mode: this.mode },
    });
  }

  /** 多分段合并的书：目录直接按章列，一点就跳到该章第一页 */
  getToc() {
    if (this.groups.length > 1) {
      // 用页表里的 count，不依赖 zip 是否已经加载
      return this.groups.filter((g) => g.count > 0).map((g) => {
        const from = g.start;
        const to = g.start + g.count - 1;
        return {
          label: g.label,
          sub: `${from + 1}–${to + 1} 页`,
          index: from,
          range: [from, to],
          level: 0,
          chapter: true,
        };
      });
    }
    return Array.from({ length: this.total }, (_, i) => ({
      label: `第 ${i + 1} 页`,
      index: i,
      level: 0,
    }));
  }

  goTo(item) {
    if (!item) return;
    // 目录里点了某一章：直接停在该章首页，不为了对开配平退回上一章
    this.goToIndex(item.index ?? 0, { exact: !!item.chapter });
  }

  get isZoomed() { return this.scale > 1; }

  get loc() {
    return this.mode === 'scroll'
      ? { page: this.visibleIndex(), ratio: this.scrollRatio, mode: 'scroll' }
      : { page: this.index, mode: this.mode };
  }

  destroy() {
    this.destroyed = true;
    this.observer?.disconnect();
    if (this.scroller) this.scroller.removeEventListener('scroll', this.onScroll);
    if (this.wrap) this.wrap.removeEventListener('wheel', this.onWheel);
    this.cache.forEach((u) => { try { URL.revokeObjectURL(u); } catch { /* ignore */ } });
    this.cache.clear();
    // 把还没释放的分段一起丢掉，别等 GC 慢慢收
    for (const g of this.groups) {
      g.zip = null;
      g.entries = null;
      g.file = null;
    }
  }

  resize() {
    if (this.mode === 'scroll') {
      const max = this.scroller.scrollHeight - this.scroller.clientHeight;
      this.scroller.scrollTop = this.scrollRatio * max;
    }
  }
}
