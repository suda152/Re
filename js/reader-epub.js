/* ===========================================================
   EPUB / TXT 阅读引擎：CSS 多栏分页
   =========================================================== */

import { loadEpub, splitTxt, zipFile, joinPath, dirOf } from './epub-parse.js';
import { clamp, debounce, escapeHtml } from './util.js';
import { partLabel } from './parts.js';

const FONT_MAP = {
  serif: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
  sans: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  kai: '"Kaiti SC", "KaiTi", "STKaiti", "Noto Serif SC", serif',
};

/** 在某一册的 spine 里定位路径（容忍大小写与编码差异） */
function indexInSpine(spine, path) {
  if (!path) return -1;
  const clean = String(path).split('#')[0];
  let i = spine.findIndex((s) => s.path === clean);
  if (i < 0) {
    const base = clean.split('/').pop();
    i = spine.findIndex((s) => s.path.split('/').pop() === base);
  }
  return i;
}

export class EpubReader {
  constructor({ book, parts, prefs, onUpdate }) {
    this.book = book;
    this.partsIn = Array.isArray(parts) ? parts : [];
    this.prefs = { ...prefs };
    this.onUpdate = onUpdate;

    this.chapter = 0;
    this.page = 0;
    this.pages = 1;
    this.colW = 0;
    this.gap = 44;
    this.total = 0;
    this.urls = [];
    this.destroyed = false;
    this.loading = false;
    this.groups = [];     // 每一册：{ label, zip, data, chapters }
    this.chapters = [];   // 全局章节索引：{ g: 册号, i: 册内序号 }
    this.starts = [];     // 每一册的全局起始序号
    this.onImgLoad = debounce(() => this.relayout(), 170);
  }

  async mount(host) {
    this.host = host;
    const isTxt = this.book.type === 'txt';
    this.isTxt = isTxt;

    for (const { meta, file } of this.partsIn) {
      if (isTxt) {
        let text = '';
        try { text = await file.text(); } catch { text = ''; }
        const chapters = splitTxt(text);
        this.addGroup({ label: partLabel(this.groups.length), name: meta.name, chapters }, chapters.length);
        continue;
      }
      let zip = null;
      let data = null;
      try {
        zip = await JSZip.loadAsync(file);
        data = await loadEpub(zip);
      } catch (err) {
        console.warn('分段解析失败，已跳过：', meta.name, err);
        continue;
      }
      if (!data.spine.length) continue;
      this.addGroup({ label: partLabel(this.groups.length), name: meta.name, zip, data }, data.spine.length);
    }

    this.total = this.chapters.length;
    if (!this.total) throw new Error('这本书没有可读的章节');
    this.toc = this.buildToc();

    host.innerHTML = `<div class="epub-wrap">
      <div class="epub-viewport">
        <div class="epub-clip"><div class="epub-flow"></div></div>
        <div class="epub-busy"><i></i></div>
      </div>
    </div>`;

    this.viewport = host.querySelector('.epub-viewport');
    this.flow = host.querySelector('.epub-flow');
    this.busyEl = host.querySelector('.epub-busy');

    this.flow.style.columnGap = `${this.gap}px`;
    this.applyPrefs(this.prefs, true);

    this.flow.addEventListener('click', (e) => this.onLinkClick(e));
    this.bindWheel();

    this.ro = new ResizeObserver(debounce(() => this.relayout(), 140));
    this.ro.observe(this.viewport);

    const loc = this.book.loc || {};
    await this.loadChapter(clamp(loc.chapter ?? 0, 0, this.total - 1), loc.page ?? 0, true);
  }

  addGroup(group, count) {
    const gi = this.groups.length;
    this.starts[gi] = this.chapters.length;
    this.groups.push(group);
    for (let i = 0; i < count; i++) this.chapters.push({ g: gi, i });
  }

  /* ---------------- 设置 ---------------- */

  applyPrefs(p, initial = false) {
    this.prefs = { ...this.prefs, ...p };
    const fs = clamp(Number(this.prefs.fontSize) || 19, 14, 34);
    const lh = clamp(Number(this.prefs.lineHeight) || 1.85, 1.2, 2.6);
    const font = FONT_MAP[this.prefs.font] || FONT_MAP.serif;
    const widthMap = { narrow: 620, normal: 780, wide: 980 };

    this.host.style.setProperty('--rfs', `${fs}px`);
    this.host.style.setProperty('--rlh', String(lh));
    this.host.style.setProperty('--rfont', font);
    if (this.viewport) {
      this.viewport.style.maxWidth = `${widthMap[this.prefs.width] || 780}px`;
    }

    if (!initial) {
      const ratio = this.pages > 1 ? (this.page + 1) / this.pages : 0;
      this.measure();
      const target = clamp(Math.round(ratio * this.pages) - 1, 0, this.pages - 1);
      this.setPage(target, true);
    }
  }

  /* ---------------- 目录 ---------------- */

  buildToc() {
    const multi = this.groups.length > 1;
    const out = [];

    for (let gi = 0; gi < this.groups.length; gi++) {
      const g = this.groups[gi];
      const start = this.starts[gi];
      let pushed = 0;

      if (this.isTxt) {
        g.chapters.forEach((c, i) => {
          out.push({ label: c.title || `第 ${start + i + 1} 节`, level: 0, index: start + i, g: gi, path: '' });
          pushed++;
        });
      } else if (g.data.toc?.length) {
        for (const t of g.data.toc) {
          const li = indexInSpine(g.data.spine, t.path);
          if (li < 0) continue;
          out.push({
            label: t.label || `第 ${li + 1} 节`,
            level: t.level || 0,
            index: start + li,
            g: gi,
            path: t.path,
            fragment: t.fragment || '',
          });
          pushed++;
        }
      }

      if (!pushed && !this.isTxt) {
        g.data.spine.forEach((s, i) => {
          out.push({ label: `第 ${i + 1} 节`, level: 0, index: start + i, g: gi, path: s.path });
        });
      }
    }

    if (multi) {
      for (const t of out) t.label = `${this.groups[t.g].label} · ${t.label}`;
    }
    return out;
  }

  /* ---------------- 章节 ---------------- */

  async getChapter(i) {
    const ref = this.chapters[i];
    if (!ref) return { html: '<p>（这一节不存在）</p>', path: '' };
    const group = this.groups[ref.g];

    if (this.isTxt) {
      const ch = group.chapters[ref.i] || { title: '', content: '' };
      const paras = ch.content.split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join('');
      return { html: `${ch.title ? `<h2>${escapeHtml(ch.title)}</h2>` : ''}${paras || '<p>（本章无内容）</p>'}`, path: '' };
    }

    const item = group.data.spine[ref.i];
    if (!item) return { html: '<p>（这一节的文件缺失）</p>', path: '' };
    const entry = zipFile(group.zip, item.path);
    if (!entry) return { html: '<p>（这一节的文件缺失）</p>', path: item.path };
    const text = await entry.async('string');
    const doc = new DOMParser().parseFromString(text, 'text/html');
    doc.querySelectorAll('script, style, link, iframe, video, audio, form, object, embed').forEach((n) => n.remove());
    doc.querySelectorAll('*').forEach((n) => {
      Array.from(n.attributes).forEach((a) => {
        if (/^on/i.test(a.name)) n.removeAttribute(a.name);
      });
    });

    // 图片：只在同一册里找，转成 objectURL
    const imgs = Array.from(doc.querySelectorAll('img'));
    for (const img of imgs) {
      const src = img.getAttribute('src');
      if (!src) { img.remove(); continue; }
      if (/^(data:|https?:|blob:)/i.test(src)) continue;
      const path = joinPath(dirOf(item.path), src);
      const file = zipFile(group.zip, path);
      if (!file) { img.remove(); continue; }
      try {
        const blob = await file.async('blob');
        const url = URL.createObjectURL(blob);
        this.urls.push(url);
        img.setAttribute('src', url);
        img.removeAttribute('srcset');
        img.removeAttribute('width');
        img.removeAttribute('height');
        img.removeAttribute('style');
      } catch {
        img.remove();
      }
    }

    // 内部链接
    doc.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (!href) return;
      a.setAttribute('data-href', href);
      a.removeAttribute('href');
    });

    const body = doc.body || doc.documentElement;
    return { html: body ? body.innerHTML : '<p>（这一节是空的）</p>', path: item.path };
  }

  async loadChapter(index, page = 0, instant = false) {
    if (this.destroyed) return;
    index = clamp(index, 0, this.total - 1);
    this.loading = true;
    this.busy(true);

    // 旧章节的 objectURL 在新内容渲染完成后统一释放
    const oldUrls = this.urls;
    this.urls = [];

    try {
      const { html } = await this.getChapter(index);
      if (this.destroyed) return;
      this.chapter = index;
      this.flow.classList.add('instant');
      this.flow.innerHTML = html;
      this.flow.scrollTop = 0;
      this.flow.querySelectorAll('img').forEach((img) => {
        if (!img.complete) img.addEventListener('load', this.onImgLoad, { once: true });
      });
      await this.waitImages();
      this.measure();
      const target = page < 0 ? this.pages - 1 : clamp(page, 0, this.pages - 1);
      this.setPage(target, true);
      this.emit();
      requestAnimationFrame(() => this.flow.classList.remove('instant'));
    } catch (err) {
      this.flow.innerHTML = `<p>这一节打不开：${escapeHtml(err.message || '未知错误')}</p>`;
      this.pages = 1;
      this.setPage(0, true);
    } finally {
      this.loading = false;
      this.busy(false);
      for (const u of oldUrls) {
        try { URL.revokeObjectURL(u); } catch { /* ignore */ }
      }
    }
  }

  waitImages() {
    const imgs = Array.from(this.flow.querySelectorAll('img'));
    if (!imgs.length) return Promise.resolve();
    return Promise.race([
      Promise.all(imgs.map((img) => (img.complete ? Promise.resolve() : new Promise((r) => {
        img.addEventListener('load', r, { once: true });
        img.addEventListener('error', r, { once: true });
      })))),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  }

  /* ---------------- 分页 ---------------- */

  measure() {
    if (!this.flow || !this.viewport) return;
    const w = this.flow.clientWidth;
    if (!w) return;
    this.colW = w;
    this.flow.style.columnWidth = `${w}px`;
    // 强制重排以拿到正确的 scrollWidth
    void this.flow.offsetWidth;
    const sw = this.flow.scrollWidth;
    this.pages = Math.max(1, Math.round((sw + this.gap) / (w + this.gap)));
  }

  setPage(p, instant = false) {
    this.page = clamp(p, 0, this.pages - 1);
    if (instant) {
      this.flow.classList.add('instant');
      clearTimeout(this._instantTimer);
      this._instantTimer = setTimeout(() => this.flow.classList.remove('instant'), 40);
    }
    this.flow.style.transform = `translateX(${-this.page * (this.colW + this.gap)}px)`;
  }

  relayout() {
    if (!this.flow || !this.pages) return;
    const ratio = this.pages > 1 ? (this.page + 1) / this.pages : 0;
    this.measure();
    const target = clamp(Math.round(ratio * this.pages) - 1, 0, this.pages - 1);
    this.setPage(target, true);
    this.emit();
  }

  /* ---------------- 翻页 ---------------- */

  async next() {
    if (this.loading) return;
    if (this.page < this.pages - 1) {
      this.setPage(this.page + 1);
      this.emit();
      return;
    }
    if (this.chapter < this.total - 1) {
      await this.loadChapter(this.chapter + 1, 0);
      return;
    }
    this.emit();
  }

  async prev() {
    if (this.loading) return;
    if (this.page > 0) {
      this.setPage(this.page - 1);
      this.emit();
      return;
    }
    if (this.chapter > 0) {
      await this.loadChapter(this.chapter - 1, -1);
    }
  }

  async seek(percent) {
    if (this.loading) return;
    const g = clamp(percent, 0, 0.999) * this.total;
    const ci = Math.floor(g);
    if (ci !== this.chapter) await this.loadChapter(ci, 0);
    else this.measure();
    const target = Math.round((g - ci) * this.pages);
    this.setPage(clamp(target, 0, this.pages - 1), true);
    this.emit();
  }

  async goToToc(item) {
    if (!item) return;
    const idx = item.index ?? this.findSpine(item.path, item.g ?? 0);
    if (idx < 0) return;
    await this.loadChapter(idx, 0);
    if (item.fragment) {
      const el = this.flow.querySelector(`#${CSS.escape(item.fragment)}`)
        || this.flow.querySelector(`[name="${CSS.escape(item.fragment)}"]`);
      if (el) {
        const x = el.getBoundingClientRect().left - this.flow.getBoundingClientRect().left;
        const p = Math.floor(x / (this.colW + this.gap));
        this.setPage(clamp(p, 0, this.pages - 1), true);
        this.emit();
      }
    }
  }

  async onLinkClick(e) {
    const a = e.target.closest('a[data-href]');
    if (!a) return;
    e.preventDefault();
    const href = a.dataset.href;
    if (/^https?:/i.test(href)) {
      window.open(href, '_blank', 'noopener');
      return;
    }
    if (href.startsWith('#')) {
      await this.goToToc({ index: this.chapter, fragment: href.slice(1) });
      return;
    }
    const cur = this.chapters[this.chapter];
    const group = this.groups[cur?.g ?? 0];
    if (!group?.data) return;
    const path = joinPath(dirOf(group.data.spine[cur.i].path), href);
    const idx = this.findSpine(path, cur.g);
    const frag = href.split('#')[1] || '';
    if (idx >= 0) await this.goToToc({ index: idx, path, fragment: frag });
  }

  /** 只在指定册内查找章节；返回全局序号，找不到返回 -1 */
  findSpine(path, gi = 0) {
    const group = this.groups[gi];
    if (!group?.data) return -1;
    const li = indexInSpine(group.data.spine, path);
    return li < 0 ? -1 : this.starts[gi] + li;
  }

  /* ---------------- 其他 ---------------- */

  bindWheel() {
    this.onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const next = clamp((this.prefs.fontSize || 19) + (e.deltaY > 0 ? -1 : 1), 14, 34);
        if (next !== this.prefs.fontSize) this.applyPrefs({ fontSize: next });
        return;
      }
      if (Math.abs(e.deltaY) < 6) return;
      e.preventDefault();
      const now = Date.now();
      if (now - (this._wheelAt || 0) < 320) return;
      this._wheelAt = now;
      if (e.deltaY > 0) this.next();
      else this.prev();
    };
    this.viewport.addEventListener('wheel', this.onWheel, { passive: false });
  }

  busy(on) {
    this.busyEl?.classList.toggle('on', !!on);
  }

  emit() {
    const pct = clamp((this.chapter + (this.page + 1) / this.pages) / this.total, 0, 1);
    const tocLabel = this.toc.find((t) => t.index === this.chapter)?.label;
    this.onUpdate({
      percent: pct,
      label: `${tocLabel ? `${tocLabel} · ` : ''}${this.page + 1} / ${this.pages}`,
      canPrev: this.page > 0 || this.chapter > 0,
      canNext: this.page < this.pages - 1 || this.chapter < this.total - 1,
      loc: { chapter: this.chapter, page: this.page },
    });
  }

  getToc() {
    return this.toc.map((t) => ({ label: t.label, level: t.level || 0, index: t.index, fragment: t.fragment || '', path: t.path || '' }));
  }

  goTo(item) {
    return this.goToToc(item);
  }

  get isZoomed() { return false; }

  get loc() {
    return { chapter: this.chapter, page: this.page };
  }

  revokeUrls(keep = 0) {
    while (this.urls.length > keep) {
      try { URL.revokeObjectURL(this.urls.shift()); } catch { /* ignore */ }
    }
  }

  destroy() {
    this.destroyed = true;
    this.ro?.disconnect();
    if (this.viewport) this.viewport.removeEventListener('wheel', this.onWheel);
    this.revokeUrls(0);
    clearTimeout(this._instantTimer);
  }

  resize() {
    this.relayout();
  }
}
