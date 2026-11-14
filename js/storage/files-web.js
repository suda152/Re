/* ===========================================================
   文件存储 · 浏览器（IndexedDB 直接存 Blob）
   =========================================================== */

import { tx, reqOf } from './idb.js';

export const webFiles = {
  kind: 'indexeddb',

  async put(id, file) {
    await tx('files', 'readwrite', (os) => {
      os.put({ id, file, size: file.size, type: file.type || '', name: file.name || '' });
    });
    return { id, size: file.size };
  },

  async get(id) {
    const rec = await tx('files', 'readonly', (os) => reqOf(os.get(id)));
    return rec ? rec.file : null;
  },

  /** 文件索引（原生实现对账用；浏览器实现直接读 Blob 记录） */
  async meta(id) {
    const rec = await tx('files', 'readonly', (os) => reqOf(os.get(id)));
    return rec ? { id: rec.id, size: rec.size, type: rec.type, name: rec.name } : null;
  },

  async remove(id) {
    await tx('files', 'readwrite', (os) => { os.delete(id); });
  },

  async clear() {
    await tx('files', 'readwrite', (os) => { os.clear(); });
  },

  async usage() {
    try {
      const est = await navigator.storage?.estimate?.();
      return { used: est?.usage || 0, quota: est?.quota || 0 };
    } catch {
      return { used: 0, quota: 0 };
    }
  },
};
