/* ===========================================================
   全局状态与事件总线
   =========================================================== */

export const state = {
  books: [],
  view: 'library',
  filter: 'all',
  query: '',
  sort: 'recent',
  ready: false,
};

export const DEFAULT_PREFS = {
  theme: 'system',
  epub: {
    fontSize: 19,
    lineHeight: 1.85,
    font: 'serif',
    theme: 'light',
    width: 'normal',
  },
  comic: {
    mode: 'single',
    fit: 'contain',
    rtl: false,
    theme: 'dark',
  },
  /** 平板 / 触屏专属行为，可在设置页单独关掉 */
  device: {
    swipe: true,          // 左右轻扫翻页
    landscapeDouble: true, // 横屏首次打开漫画用双页
    keepAwake: true,       // 阅读时屏幕常亮（仅原生壳生效）
  },
};

export const prefs = structuredClone(DEFAULT_PREFS);

const bus = new EventTarget();

export function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

export function on(type, fn) {
  const handler = (e) => fn(e.detail);
  bus.addEventListener(type, handler);
  return () => bus.removeEventListener(type, handler);
}

/** 深度合并保存的偏好，避免旧版本缺字段 */
export function mergePrefs(saved) {
  if (!saved || typeof saved !== 'object') return;
  for (const k of Object.keys(DEFAULT_PREFS)) {
    const v = saved[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      prefs[k] = { ...DEFAULT_PREFS[k], ...v };
    } else if (v !== undefined) {
      prefs[k] = v;
    }
  }
}

export const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));
