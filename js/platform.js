/* ===========================================================
   平台探测：平板 / 桌面、横竖屏、安全区、性能档位、原生壳
   - 只在启动时测一次，之后靠 media query 与 resize 更新
   - 结果写到 <html data-*>，样式侧不用重复判断
   =========================================================== */

export const platform = {
  native: false,
  /** phone | tablet | desktop */
  layout: 'desktop',
  tablet: false,
  /** portrait | landscape */
  orientation: 'landscape',
  touch: false,
  /** 低性能设备：关掉模糊层 */
  lowPower: false,
  safe: { top: 0, right: 0, bottom: 0, left: 0 },
  size: { w: 0, h: 0 },
  dpr: 1,
};

const listeners = new Set();

/** 原生壳推上来的窗口内边距（CSS px），和 env() 取较大值 */
let nativeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/** 订阅平台变化（旋转、窗口尺寸、安全区变化） */
export function onPlatform(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emitChange() {
  const snap = { ...platform, safe: { ...platform.safe }, size: { ...platform.size } };
  for (const fn of listeners) {
    try { fn(snap); } catch (err) { console.warn('platform listener failed', err); }
  }
}

/* ---------------- 安全区实测 ---------------- */

const SAFE_PROBE = 'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;'
  + 'pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) '
  + 'env(safe-area-inset-bottom) env(safe-area-inset-left);';

function measureSafeArea() {
  let probe = document.getElementById('safeProbe');
  if (!probe) {
    probe = document.createElement('div');
    probe.id = 'safeProbe';
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = SAFE_PROBE;
    document.body.appendChild(probe);
  }
  const cs = getComputedStyle(probe);
  return {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
}

function applySafeArea() {
  const env = measureSafeArea();
  const safe = {
    top: Math.max(env.top, nativeInsets.top || 0),
    right: Math.max(env.right, nativeInsets.right || 0),
    bottom: Math.max(env.bottom, nativeInsets.bottom || 0),
    left: Math.max(env.left, nativeInsets.left || 0),
  };
  platform.safe = safe;
  const root = document.documentElement;
  root.style.setProperty('--safe-top', `${safe.top}px`);
  root.style.setProperty('--safe-right', `${safe.right}px`);
  root.style.setProperty('--safe-bottom', `${safe.bottom}px`);
  root.style.setProperty('--safe-left', `${safe.left}px`);
}

/**
 * 原生壳在窗口 inset 变化时调用（Android 的刘海 / 手势条在 WebView 里
 * 不一定能通过 env() 读到，所以由 MainActivity 实测后推过来）
 */
export function setNativeInsets(insets) {
  if (!insets) return;
  nativeInsets = {
    top: Number(insets.top) || 0,
    right: Number(insets.right) || 0,
    bottom: Number(insets.bottom) || 0,
    left: Number(insets.left) || 0,
  };
  if (!started) return;
  applySafeArea();
  emitChange();
}

/* ---------------- 环境判断 ---------------- */

const coarse = () => window.matchMedia?.('(pointer: coarse)').matches ?? false;
const fine = () => window.matchMedia?.('(pointer: fine)').matches ?? false;

function compute() {
  const w = window.innerWidth || document.documentElement.clientWidth;
  const h = window.innerHeight || document.documentElement.clientHeight;
  // 粗指针优先：带触摸屏的笔记本会同时报 maxTouchPoints=10 和 fine 指针，
  // 那种情况仍按鼠标处理，否则整站会套上 44px 触控尺寸
  const touch = coarse() || ((navigator.maxTouchPoints || 0) > 0 && !fine());

  platform.size = { w, h };
  platform.orientation = w > h ? 'landscape' : 'portrait';
  platform.touch = touch;
  platform.dpr = window.devicePixelRatio || 1;

  // 平板：够宽，或「短边 ≥ 600 且触屏」——小屏手机即使横过来也不算
  const minSide = Math.min(w, h);
  platform.tablet = w >= 700 || (touch && minSide >= 600);
  platform.layout = platform.tablet ? 'tablet' : (w >= 1000 ? 'desktop' : 'phone');

  const mem = navigator.deviceMemory || 0;
  const cores = navigator.hardwareConcurrency || 8;
  platform.lowPower = (mem > 0 && mem <= 4) || cores <= 4;

  const root = document.documentElement;
  root.dataset.platform = platform.layout;
  root.dataset.orientation = platform.orientation;
  root.dataset.input = touch ? 'touch' : 'pointer';
  root.dataset.perf = platform.lowPower ? 'low' : 'high';
  root.dataset.runtime = platform.native ? 'native' : 'web';
}

/* ---------------- 启动 ---------------- */

let started = false;

export function initPlatform() {
  if (started) return platform;
  started = true;

  platform.native = !!window.Capacitor?.isNativePlatform?.()
    || (!!window.Capacitor?.platform && window.Capacitor.platform !== 'web');

  // 原生壳通过 evaluateJavascript 推送真实 inset
  window.__setNativeInsets = setNativeInsets;

  applySafeArea();
  compute();

  let raf = 0;
  const refresh = (full = false) => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (full) applySafeArea();
      const before = `${platform.layout}|${platform.orientation}|${platform.size.w}x${platform.size.h}|${platform.safe.top}`;
      compute();
      const after = `${platform.layout}|${platform.orientation}|${platform.size.w}x${platform.size.h}|${platform.safe.top}`;
      if (before !== after) emitChange();
    });
  };

  window.addEventListener('resize', () => refresh(false));
  window.addEventListener('orientationchange', () => {
    // 旋转后系统栏高度要等一帧才稳定
    refresh(true);
    setTimeout(() => refresh(true), 260);
  });
  window.visualViewport?.addEventListener('resize', () => refresh(false));
  window.matchMedia?.('(pointer: coarse)')?.addEventListener?.('change', () => refresh(false));

  // 首次布局可能发生在安全区稳定之前
  setTimeout(() => refresh(true), 120);
  return platform;
}

/** 屏幕够宽、可以并排显示侧栏面板（详情 / 目录） */
export function isWideLandscape() {
  return platform.size.w >= 1000 && platform.orientation === 'landscape';
}

/** 当前环境的中文描述，设置页展示用 */
export function platformText() {
  const { w, h } = platform.size;
  const safe = platform.safe;
  const safeTxt = [safe.top, safe.right, safe.bottom, safe.left].some((n) => n > 0)
    ? `安全区 ${Math.round(safe.top)}/${Math.round(safe.right)}/${Math.round(safe.bottom)}/${Math.round(safe.left)}`
    : '无刘海遮挡';
  const kind = platform.native ? '平板 App' : (platform.tablet ? '平板浏览器' : '桌面浏览器');
  return `${kind} · ${w}×${h} · ${platform.orientation === 'landscape' ? '横屏' : '竖屏'} · ${safeTxt}`;
}
