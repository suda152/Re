/* ===========================================================
   文件存储 · 原生壳（Capacitor Filesystem）
   - 压缩包落应用私有目录，IndexedDB 只留一份索引
   - 写入分块（4 MB），避免几十 MB 的漫画一次进 base64 把内存打满
   - 读取走 convertFileSrc + fetch，同样不把 base64 送回 JS
   =========================================================== */

import { tx, reqOf } from './idb.js';

const CHUNK = 4 * 1024 * 1024;
const DIR = 'DATA';       // 对应 Directory.Data（应用私有，卸载即清）
const ROOT = 'books';
const INDEX = 'files';    // IndexedDB 里的索引 store

const plugins = () => window.Capacitor?.Plugins || {};
const FS = () => plugins().Filesystem;

function safeName(id, name = '') {
  const ext = (String(name).match(/\.([a-z0-9]{1,5})$/i) || [])[1];
  const base = String(id).replace(/[^\w.-]/g, '_');
  return ext ? `${ROOT}/${base}.${ext.toLowerCase()}` : `${ROOT}/${base}.bin`;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(r.error || new Error('读取文件失败'));
    r.readAsDataURL(blob);
  });
}

async function writeChunked(path, file) {
  const fs = FS();
  const total = Math.ceil(file.size / CHUNK) || 1;
  for (let i = 0; i < total; i++) {
    const slice = file.slice(i * CHUNK, Math.min(file.size, (i + 1) * CHUNK));
    const data = await blobToBase64(slice);
    if (i === 0) {
      await fs.writeFile({ path, data, directory: DIR, recursive: true });
    } else {
      await fs.appendFile({ path, data, directory: DIR });
    }
  }
}

export const nativeFiles = {
  kind: 'filesystem',

  async put(id, file) {
    const fs = FS();
    if (!fs) throw new Error('原生文件系统不可用');
    const path = safeName(id, file.name);
    await writeChunked(path, file);
    await tx(INDEX, 'readwrite', (os) => {
      os.put({ id, name: file.name || '', type: file.type || '', size: file.size, path });
    });
    return { id, path, size: file.size };
  },

  /**
   * 文件已经由原生写进 books/，这里只登记索引（批量导入用，避免二次复制）
   * @param {string} id
   * @param {{path:string,size:number,name?:string,type?:string}} meta
   */
  async adopt(id, meta) {
    const path = String(meta?.path || '').replace(/^\/+/, '');
    if (!path) throw new Error('缺少文件路径');
    await tx(INDEX, 'readwrite', (os) => {
      os.put({
        id,
        name: meta.name || '',
        type: meta.type || '',
        size: meta.size || 0,
        path,
        adopted: true,
      });
    });
    return { id, path, size: meta.size || 0 };
  },

  async meta(id) {
    return tx(INDEX, 'readonly', (os) => reqOf(os.get(id)));
  },

  async get(id) {
    const fs = FS();
    const rec = await this.meta(id);
    if (!rec || !fs) return null;
    try {
      const { uri } = await fs.getUri({ path: rec.path, directory: DIR });
      const src = window.Capacitor?.convertFileSrc
        ? window.Capacitor.convertFileSrc(uri)
        : uri;
      const res = await fetch(src);
      const buf = await res.arrayBuffer();
      return new File([buf], rec.name || `${id}.bin`, { type: rec.type || '' });
    } catch (err) {
      console.warn('读取本地文件失败', rec.path, err);
      return null;
    }
  },

  async remove(id) {
    const fs = FS();
    const rec = await this.meta(id);
    if (rec && fs) {
      try {
        await fs.deleteFile({ path: rec.path, directory: DIR });
      } catch (err) {
        console.warn('删除本地文件失败', rec.path, err);
      }
    }
    await tx(INDEX, 'readwrite', (os) => { os.delete(id); });
  },

  async clear() {
    const fs = FS();
    if (fs) {
      try {
        const { files } = await fs.readdir({ path: ROOT, directory: DIR });
        for (const f of files || []) {
          if (f.type === 'file') {
            await fs.deleteFile({ path: `${ROOT}/${f.name}`, directory: DIR }).catch(() => {});
          }
        }
      } catch {
        /* 目录还不存在，忽略 */
      }
    }
    await tx(INDEX, 'readwrite', (os) => { os.clear(); });
  },

  /**
   * 清掉 books/ 里没有索引记录的文件
   * 来源：导入中途停止、重复文件先落盘后判重留下的残片
   * @param {Set<string>} [protect] 额外保护的文件名（正在写入的）
   */
  async sweep(protect) {
    const fs = FS();
    if (!fs) return { removed: 0, freed: 0 };
    const all = await tx(INDEX, 'readonly', (os) => reqOf(os.getAll()));
    const keep = new Set((all || []).map((r) => String(r.path || '').split('/').pop()));
    if (protect) for (const p of protect) keep.add(p);

    let removed = 0;
    let freed = 0;
    try {
      const { files } = await fs.readdir({ path: ROOT, directory: DIR });
      for (const f of files || []) {
        if (f.type !== 'file' || keep.has(f.name)) continue;
        try {
          await fs.deleteFile({ path: `${ROOT}/${f.name}`, directory: DIR });
          removed++;
          freed += f.size || 0;
        } catch { /* 单个删不掉不影响整体 */ }
      }
    } catch {
      /* 目录还不存在 */
    }
    return { removed, freed };
  },

  async usage() {
    let used = 0;
    try {
      const all = await tx(INDEX, 'readonly', (os) => reqOf(os.getAll()));
      used = (all || []).reduce((sum, rec) => sum + (rec.size || 0), 0);
    } catch {
      used = 0;
    }
    // 原生侧拿不到系统配额，用「设备剩余」估算一个上限
    let quota = 0;
    try {
      const est = await navigator.storage?.estimate?.();
      quota = est?.quota || 0;
    } catch {
      quota = 0;
    }
    return { used, quota };
  },
};
