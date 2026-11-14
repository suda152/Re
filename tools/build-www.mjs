/* ===========================================================
   打包前端到 www/（Capacitor 的 webDir）
   - 只拷运行时需要的资源，docs / samples / tools / node_modules 不进去
   - 零构建：src 与产物一致，diff 一眼能看出来
   =========================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'www');

const INCLUDE = [
  'index.html',
  'manifest.webmanifest',
  'css',
  'js',
  'vendor',
  'assets',
];

function rmrf(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function copy(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) copy(path.join(src, name), path.join(dest, name));
  } else {
    fs.copyFileSync(src, dest);
  }
}

rmrf(OUT);
fs.mkdirSync(OUT, { recursive: true });

let files = 0;
let bytes = 0;
for (const name of INCLUDE) {
  const src = path.join(ROOT, name);
  if (!fs.existsSync(src)) {
    console.warn(`跳过（不存在）：${name}`);
    continue;
  }
  copy(src, path.join(OUT, name));
}
for (const dir of ['css', 'js', 'vendor', 'assets']) {
  const p = path.join(OUT, dir);
  if (!fs.existsSync(p)) continue;
  for (const f of fs.readdirSync(p, { recursive: true })) {
    const full = path.join(p, f);
    if (fs.statSync(full).isFile()) {
      files++;
      bytes += fs.statSync(full).size;
    }
  }
}

console.log(`www/ 已生成：${files} 个文件，${(bytes / 1024).toFixed(0)} KB`);
