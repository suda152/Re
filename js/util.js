/* ===========================================================
   通用工具
   =========================================================== */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function fmtBytes(n) {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  if (diff < 7 * 86400e3) return `${Math.floor(diff / 86400e3)} 天前`;
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

/** 阅读时长：完整表达（详情页）。「3 小时 24 分」「45 分钟」 */
export function fmtDuration(sec) {
  sec = Math.round(Number(sec) || 0);
  if (sec <= 0) return '还没读过';
  if (sec < 60) return `${sec} 秒`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m} 分钟`;
  if (h < 100) return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
  return `${h.toLocaleString()} 小时`;
}

/** 阅读时长：紧凑两段式 [数字, 单位]（统计卡）。 */
export function fmtDurationShort(sec) {
  sec = Number(sec) || 0;
  if (sec < 60) return ['0', '分钟'];
  if (sec < 3600) return [String(Math.round(sec / 60)), '分钟'];
  const h = sec / 3600;
  return [h >= 100 ? String(Math.round(h)) : h.toFixed(1), '小时'];
}

/** 文件名自然排序：page2 < page10 */
export function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

export function debounce(fn, wait = 300) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

/* ---------------- Toast ---------------- */

/**
 * @param {string} msg
 * @param {string} [type] '' | 'err' | 'ok'
 * @param {{label?:string, onClick?:Function, duration?:number}} [action] 带一个可点按钮（用于「撤销」）
 */
export function toast(msg, type = '', action) {
  const wrap = $('#toastWrap');
  if (!wrap) return null;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const text = document.createElement('span');
  text.textContent = msg;
  el.appendChild(text);

  const duration = action?.duration || 2400;
  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  };

  if (action?.label) {
    const btn = document.createElement('button');
    btn.className = 'toast-act';
    btn.textContent = action.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
      action.onClick?.();
    });
    el.appendChild(btn);
  }

  wrap.appendChild(el);
  setTimeout(close, duration);
  return el;
}

/* ---------------- 确认框 ---------------- */

// 上一次 confirmDialog 的收尾函数：新开一个之前先把旧的结掉，
// 否则旧 Promise 会一直挂着，它的按钮监听器也会留在 DOM 上
let activeDone = null;

export function confirmDialog({ title = '确认', text = '', ok = '确定', cancel = '取消', danger = true }) {
  const dlg = $('#confirmDialog');
  const okBtn = $('#confirmOk');
  const cancelBtn = $('#confirmCancel');

  // 残留的那次当作「取消」，避免它下次被点击时误触发自己的后续动作
  if (activeDone) {
    try { activeDone(false); } catch { /* ignore */ }
    activeDone = null;
  }
  // 再兜底清一遍（旧版本可能已经泄漏了监听器）
  if (dlg._cleanup) {
    try { dlg._cleanup(); } catch { /* ignore */ }
    dlg._cleanup = null;
  }

  return new Promise((resolve) => {
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    okBtn.textContent = ok;
    okBtn.className = `btn ${danger ? 'danger' : 'primary'}`;
    cancelBtn.textContent = cancel;

    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
      cancelBtn.removeEventListener('click', onCancel2);
      dlg._cleanup = null;
      activeDone = null;
      if (dlg.open) dlg.close();
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = (e) => { e.preventDefault?.(); done(false); };
    // backdrop / Esc 走原生 cancel 事件；部分 WebView 点遮罩也会走这里
    const onCancel2 = () => done(false);

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    cancelBtn.addEventListener('click', onCancel2);
    dlg.addEventListener('cancel', onCancel);
    dlg._cleanup = () => {
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      cancelBtn.removeEventListener('click', onCancel2);
      dlg.removeEventListener('cancel', onCancel);
    };
    activeDone = done;

    if (dlg.open) dlg.close();
    dlg.showModal();
    // 默认焦点给「取消」：回车/误触不会直接确认掉危险操作
    cancelBtn.focus();
  });
}

/* ---------------- 图片 ---------------- */

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/** 把图片压缩成封面，避免把几 MB 的原图塞进书库记录 */
export async function makeCover(blob, maxW = 520) {
  try {
    const url = URL.createObjectURL(blob);
    const img = await loadImage(url);
    const scale = Math.min(1, maxW / img.naturalWidth);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a1815';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return null;
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** 没有封面时生成一张排版封面（不是占位图，是纯文字封面） */
export function fallbackCover(title, kicker = '') {
  const t = String(title || '未命名').trim().slice(0, 40);
  /* 瑞士风格：封面占位用冷灰阶（哈希只决定深浅），不再随机取色 */
  const gray = 20 + (hashStr(t) % 14);           /* 20%–33% 亮度 */
  const bg1 = `hsl(220 6% ${gray}%)`;
  const bg2 = `hsl(220 8% ${Math.max(10, gray - 9)}%)`;
  const chars = Array.from(t);
  const perLine = t.length > 18 ? 9 : t.length > 10 ? 7 : 6;
  const lines = [];
  for (let i = 0; i < chars.length && lines.length < 4; i += perLine) {
    lines.push(chars.slice(i, i + perLine).join(''));
  }
  const fs = lines.length >= 3 ? 44 : 54;
  const lh = fs * 1.5;
  const startY = 400 - ((lines.length - 1) * lh) / 2;
  const text = lines
    .map((l, i) => `<text x="300" y="${startY + i * lh}" text-anchor="middle" font-family="Inter, PingFang SC, Microsoft YaHei, sans-serif" font-size="${fs}" fill="rgba(240,242,244,.94)" font-weight="300" letter-spacing="3">${escapeHtml(l)}</text>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/>
    </linearGradient></defs>
    <rect width="600" height="800" fill="url(#g)"/>
    <rect x="26" y="26" width="548" height="748" fill="none" stroke="rgba(240,242,244,.18)" stroke-width="1.5"/>
    <text x="300" y="120" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="20" font-weight="300" fill="rgba(240,242,244,.42)" letter-spacing="6">Re</text>
    ${text}
    <line x1="240" y1="${Math.min(700, startY + lines.length * lh - 10)}" x2="360" y2="${Math.min(700, startY + lines.length * lh - 10)}" stroke="rgba(240,242,244,.22)"/>
    <text x="300" y="720" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="16" fill="rgba(240,242,244,.4)" letter-spacing="4">${escapeHtml(kicker)}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
