/* ===========================================================
   原生壳桥接（Capacitor / Android WebView）
   - 全部能力都要在纯浏览器里安全降级：没有 Capacitor 就什么都不做
   - 返回键、状态栏、常亮、系统文件选择器
   =========================================================== */

const cap = () => window.Capacitor;
const plugins = () => cap()?.Plugins || {};

export const native = {
  available: false,
  /** 文件选择器是否走系统 SAF */
  picker: false,
  /** 是否支持「选整个目录批量导入」 */
  folder: false,

  async init({ back, stateChange, onPick } = {}) {
    this.available = !!cap()?.isNativePlatform?.() || (!!cap()?.platform && cap().platform !== 'web');
    this.picker = !!plugins().BookPicker?.pick;
    this.folder = !!plugins().BookPicker?.pickFolder;

    if (!this.available) {
      // 纯浏览器：保留原生返回事件入口，便于在调试时手工触发
      window.addEventListener('native-back', () => back?.());
      return this;
    }

    // 系统返回手势 / 返回键
    try {
      await plugins().App?.addListener?.('backButton', ({ canGoBack } = {}) => {
        const consumed = back?.();
        // 书架页再按返回才退出，避免阅读中误退
        if (!consumed) this.exit();
        else if (canGoBack === false) { /* 交给我们处理，不退出 */ }
      });
    } catch (err) {
      console.warn('注册返回键失败', err);
    }

    window.addEventListener('native-back', () => {
      if (!back?.()) this.exit();
    });

    // 切到后台立即落盘，别等防抖
    try {
      await plugins().App?.addListener?.('appStateChange', ({ isActive }) => {
        stateChange?.(!!isActive);
      });
    } catch (err) {
      console.warn('注册生命周期失败', err);
    }

    // 沉浸式状态栏：webview 走 overlay，安全区由 env() 提供
    try {
      await plugins().StatusBar?.setOverlaysWebView?.({ overlay: true });
    } catch { /* 插件可缺省 */ }

    document.addEventListener('visibilitychange', () => {
      stateChange?.(!document.hidden);
    });

    return this;
  },

  /** 阅读器全屏时隐藏状态栏 */
  async immersive(on) {
    if (!this.available) return;
    try {
      if (on) {
        await plugins().StatusBar?.hide?.();
        await plugins().StatusBar?.setStyle?.({ style: 'DARK' });
      } else {
        await plugins().StatusBar?.show?.();
      }
    } catch { /* 忽略 */ }
  },

  /** 阅读时保持屏幕常亮 */
  async keepAwake(on) {
    if (!this.available) return;
    const p = plugins().KeepAwake;
    if (!p) return;
    try {
      if (on) await p.keepAwake?.();
      else await p.allowSleep?.();
    } catch { /* 忽略 */ }
  },

  /**
   * 系统文件选择器（SAF）
   * @returns {Promise<File[]|null>} 没装插件时返回 null，调用方退回 input[type=file]
   */
  async pickFiles() {
    const p = plugins().BookPicker;
    if (!this.available || !p?.pick) return null;
    const res = await p.pick();
    const list = res?.files || [];
    const out = [];
    for (const item of list) {
      try {
        let uri = item.path || item.uri;
        if (!uri) continue;
        // BookPicker 回的是绝对路径，转成 file:// 再交给 Capacitor 映射
        if (!/^(file|content|https?):/.test(uri)) uri = `file://${uri}`;
        const src = cap().convertFileSrc ? cap().convertFileSrc(uri) : uri;
        const blob = await (await fetch(src)).blob();
        out.push(new File([blob], item.name || 'book', { type: item.type || blob.type || '' }));
      } catch (err) {
        console.warn('读取所选文件失败', item?.name, err);
      }
    }
    return out;
  },

  /**
   * 选整个目录（批量导入）
   * @returns {Promise<{treeUri:string, files:Array, truncated:boolean}|null>}
   *   没装插件/纯浏览器时返回 null
   */
  async pickFolder(initialUri) {
    const p = plugins().BookPicker;
    if (!this.available || !p?.pickFolder) return null;
    const res = await p.pickFolder(initialUri ? { initialUri } : {});
    return {
      treeUri: res?.treeUri || '',
      files: Array.isArray(res?.files) ? res.files : [],
      truncated: !!res?.truncated,
    };
  },

  /** 枚举进度（原生每 25 个文件推一次） */
  onEnumProgress(cb) {
    try {
      return plugins().BookPicker?.addListener?.('enumProgress', cb);
    } catch {
      return null;
    }
  },

  /**
   * 把目录里的一个文件直接写进应用私有书库（不经过缓存）
   * @returns {Promise<{path:string,size:number,pages:number,coverPath:string|null,ext:string}>}
   */
  async stageFile(entry, id) {
    const p = plugins().BookPicker;
    if (!this.available || !p?.stage) throw new Error('当前版本不支持批量导入');
    return p.stage({ uri: entry.uri, id, name: entry.name });
  },

  /** 原生抽出来的封面图（已落在 cache/covers）→ Blob */
  async coverBlob(path) {
    if (!path) return null;
    try {
      const uri = path.startsWith('file://') ? path : `file://${path}`;
      const src = cap()?.convertFileSrc ? cap().convertFileSrc(uri) : uri;
      const res = await fetch(src);
      if (!res.ok) return null;
      return await res.blob();
    } catch (err) {
      console.warn('读取封面失败', path, err);
      return null;
    }
  },

  /** 批量导入结束后清掉封面临时文件 */
  async clearCovers() {
    try {
      return await plugins().BookPicker?.clearCovers?.();
    } catch {
      return null;
    }
  },

  /** 清掉选文件留下的缓存副本 */
  async clearCache() {
    try {
      return await plugins().BookPicker?.clearCache?.();
    } catch {
      return null;
    }
  },

  exit() {
    try {
      plugins().App?.exitApp?.();
    } catch {
      history.back();
    }
  },

  minimize() {
    try {
      plugins().App?.minimizeApp?.();
    } catch { /* 忽略 */ }
  },
};

/* ---------------- 全屏 / 常亮的业务包装 ---------------- */

let awakeHeld = false;

export async function holdAwake(enabled) {
  if (enabled === awakeHeld) return;
  awakeHeld = enabled;
  await native.keepAwake(enabled);
}
