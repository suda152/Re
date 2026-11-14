/* ===========================================================
   本地数据层
   - books  书籍元数据（含进度、分段列表）
   - files  原始文件：浏览器存 Blob，原生壳存私有目录 + 索引
   - prefs  偏好设置
   =========================================================== */

import { bookParts } from './parts.js';
import { tx, txStores, reqOf } from './storage/idb.js';
import { files as fileStore } from './storage/index.js';

export const db = {
  async allBooks() {
    const list = await tx('books', 'readonly', (os) => reqOf(os.getAll()));
    return (list || []).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  },

  async getBook(id) {
    return tx('books', 'readonly', (os) => reqOf(os.get(id)));
  },

  async putBook(book) {
    await tx('books', 'readwrite', (os) => { os.put(book); });
    return book;
  },

  async deleteBook(idOrBook) {
    const book = typeof idOrBook === 'string' ? await this.getBook(idOrBook) : idOrBook;
    if (!book) return;
    const partIds = [...new Set(bookParts(book).map((p) => p.id))];
    await this.deleteBookRecord(book.id);
    for (const pid of partIds) await this.deleteFile(pid);
  },

  /** 只删书目记录，保留分段文件（合并书籍时用） */
  async deleteBookRecord(id) {
    await tx('books', 'readwrite', (os) => { os.delete(id); });
  },

  async putFile(id, file) {
    await fileStore.put(id, file);
  },

  /** 批量导入：文件已由原生落盘，只登记索引 */
  async adoptFile(id, meta) {
    await fileStore.adopt(id, meta);
  },

  /** 清掉没有索引引用的残片（中断的导入、判重后丢弃的副本） */
  async sweepFiles(protect) {
    return fileStore.sweep(protect);
  },

  async getFile(id) {
    return fileStore.get(id);
  },

  async deleteFile(id) {
    await fileStore.remove(id);
  },

  async getPref(k, dflt = null) {
    const rec = await tx('prefs', 'readonly', (os) => reqOf(os.get(k)));
    return rec ? rec.v : dflt;
  },

  async setPref(k, v) {
    await tx('prefs', 'readwrite', (os) => { os.put({ k, v }); });
    return v;
  },

  async clearAll() {
    await txStores(['books', 'files', 'prefs'], 'readwrite', (t) => {
      t.objectStore('books').clear();
      t.objectStore('files').clear();
      t.objectStore('prefs').clear();
    });
    // 原生壳里文件在私有目录，索引清掉后还要删真文件
    await fileStore.clear().catch(() => {});
  },

  async usage() {
    return fileStore.usage();
  },

  /** 当前文件存储后端：indexeddb | filesystem */
  get fileBackend() {
    return fileStore.kind;
  },
};
