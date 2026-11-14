/* ===========================================================
   文件存储入口：按运行环境选实现
   - 浏览器：IndexedDB 存 Blob
   - 原生壳：私有目录 + IndexedDB 索引
   其余模块只认 files.put / get / remove / clear / usage
   =========================================================== */

import { webFiles } from './files-web.js';

const isNative = () => {
  const cap = window.Capacitor;
  if (!cap) return false;
  if (typeof cap.isNativePlatform === 'function') return cap.isNativePlatform();
  return cap.platform && cap.platform !== 'web';
};

let impl = webFiles;

if (isNative() && window.Capacitor?.Plugins?.Filesystem) {
  try {
    const mod = await import('./files-native.js');
    impl = mod.nativeFiles;
  } catch (err) {
    console.warn('原生文件存储加载失败，回退到 IndexedDB', err);
  }
}

export const files = {
  get kind() { return impl.kind; },
  put: (id, file) => impl.put(id, file),
  /** 文件已在磁盘上，只写索引；浏览器端没有这个概念，退化成 put */
  adopt: (id, meta) => (impl.adopt ? impl.adopt(id, meta) : impl.put(id, meta?.file || new File([], meta?.name || 'book'))),
  get: (id) => impl.get(id),
  meta: (id) => impl.meta(id),
  remove: (id) => impl.remove(id),
  sweep: (protect) => (impl.sweep ? impl.sweep(protect) : Promise.resolve({ removed: 0, freed: 0 })),
  clear: () => impl.clear(),
  usage: () => impl.usage(),
};
