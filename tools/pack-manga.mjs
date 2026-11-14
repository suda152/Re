#!/usr/bin/env node
/* ===========================================================
   把漫画目录整理成「一话一个 CBZ」并统一命名
   —— 批量导入的前置工具（PC 端，不依赖任何第三方包）

   用法：
     node tools/pack-manga.mjs <漫画目录> [选项]

   选项：
     --out <dir>       输出目录，默认 <漫画目录>/../yice-import
     --book <name>     系列书名，默认取源目录名
     --digits <n>      话号位数，默认 3（第001话）
     --start <n>       起始话号，默认 1
     --force           目标已存在时覆盖
     --dry-run         只体检，不写文件
     --bundle <n>      每 n 话再打一个传输合集包（.zip，仅便于一次性拷贝/备份）
     --json <path>     额外输出清单 JSON

   判定规则：
     - 任意层级、直接含图片的目录 = 一话
     - 源目录根下的散图 = 一话（用目录名当话名）
     - 已有的 cbz/zip/epub/txt/md/pdf = 原样搬运（不改名）
     - cbr/rar 会被列出并跳过（App 读不了 RAR）
   =========================================================== */

import fs from 'node:fs';
import path from 'node:path';

const IMG_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const MOVE_RE = /\.(cbz|zip|epub|txt|md|markdown|pdf)$/i;
const RAR_RE = /\.(cbr|rar)$/i;
const SKIP_DIR = /^(__MACOSX|\.git|\.DS_Store|\..+)$/;
const MAX_FILE = 400 * 1024 * 1024; // 与 import.js 的 MAX_FILE_SIZE 一致
const MAX_PARTS = 2000;             // 与 main.js findSeriesBook 的上限一致

/* ---------------- 参数 ---------------- */

const argv = process.argv.slice(2);
const opts = {
  src: null, out: null, book: null, digits: 3, start: 1,
  force: false, dry: false, bundle: 0, json: null,
};

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') opts.out = argv[++i];
  else if (a === '--book') opts.book = argv[++i];
  else if (a === '--digits') opts.digits = Number(argv[++i]) || 3;
  else if (a === '--start') opts.start = Number(argv[++i]) || 1;
  else if (a === '--force') opts.force = true;
  else if (a === '--dry-run') opts.dry = true;
  else if (a === '--bundle') opts.bundle = Number(argv[++i]) || 0;
  else if (a === '--json') opts.json = argv[++i];
  else if (!a.startsWith('-') && !opts.src) opts.src = a;
  else if (a === '-h' || a === '--help') usage(0);
  else usage(1, `未知参数：${a}`);
}

function usage(code, msg) {
  if (msg) console.error(`\n✗ ${msg}`);
  console.error(`
用法：node tools/pack-manga.mjs <漫画目录> [--out 目录] [--book 书名]
       [--digits 3] [--start 1] [--force] [--dry-run]
       [--bundle 每包话数] [--json 清单路径]

示例：
  node tools/pack-manga.mjs "D:/manga/葬送的芙莉莲" --book "葬送的芙莉莲"
  node tools/pack-manga.mjs "D:/manga" --dry-run
  node tools/pack-manga.mjs "D:/manga/海贼王" --bundle 50
`);
  process.exit(code);
}

if (!opts.src) usage(1, '缺少漫画目录');
const SRC = path.resolve(opts.src);
if (!fs.existsSync(SRC) || !fs.statSync(SRC).isDirectory()) usage(1, `目录不存在：${SRC}`);

const BOOK = (opts.book || path.basename(SRC)).trim();
const OUT = path.resolve(opts.out || path.join(path.dirname(SRC), 'yice-import'));

/* ---------------- 扫描 ---------------- */

const chapters = [];   // { dir, name, images: [abs], parsed: number|null }
const passthrough = []; // { file, size, name }
const problems = [];
const notes = [];

function listDir(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (err) { problems.push(`${dir} 读取失败：${err.message}`); }
  return names;
}

function walk(dir, isRoot) {
  const names = listDir(dir);
  const images = [];
  const dirs = [];
  for (const n of names) {
    if (SKIP_DIR.test(n) || n === 'Thumbs.db') continue;
    const p = path.join(dir, n);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      // 输出目录若落在源目录里（默认布局），不要把它自己也扫进来
      if (path.resolve(p) === OUT) continue;
      dirs.push(p);
    }
    else if (IMG_RE.test(n)) images.push(p);
    else if (RAR_RE.test(n)) problems.push(`RAR 无法导入，请先转 CBZ：${p}`);
    else if (MOVE_RE.test(n)) passthrough.push({ file: p, size: st.size, name: n });
  }

  if (images.length) {
    chapters.push({ dir, name: path.basename(dir), images, root: !!isRoot });
  }
  for (const d of dirs) walk(d, false);
}

walk(SRC, true);

/* ---------------- 话号 ---------------- */

function chapterNo(name) {
  const s = name.trim();
  const pats = [
    /第\s*([0-9]{1,4})\s*[话話章卷冊册集部篇回节節]/,
    /(?:^|[\s_.\-])(?:v|vol|volume|ch|chap|chapter|ep)\.?\s*([0-9]{1,4})(?=$|[\s_.\-])/i,
    /(?:^|[\s_.\-])([0-9]{1,4})(?=$|[\s_.\-])/,
    /([0-9]{1,4})\s*$/,
  ];
  for (const re of pats) {
    const m = s.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

// 全部能解析出编号才用真实话号，否则按自然顺序编号（避免重复/乱序）
const allParsed = chapters.length > 0 && chapters.every((c) => chapterNo(c.name) != null);
chapters.sort((a, b) => {
  if (allParsed) {
    const d = chapterNo(a.name) - chapterNo(b.name);
    if (d) return d;
  }
  return naturalCompare(a.dir, b.dir);
});
if (!allParsed) {
  notes.push('部分目录名里没有话号，已按自然顺序重新编号（第001话、第002话…）');
}

chapters.forEach((c, i) => {
  const parsed = chapterNo(c.name);
  c.no = allParsed ? parsed : opts.start + i;
  c.outName = `${BOOK} 第${String(c.no).padStart(opts.digits, '0')}话.cbz`;
});
if (allParsed && opts.start !== 1) {
  // 用户显式给了起始号又全部能解析时，整体平移
  chapters.forEach((c) => { c.no = c.no - 1 + opts.start; c.outName = `${BOOK} 第${String(c.no).padStart(opts.digits, '0')}话.cbz`; });
}

/* ---------------- ZIP（仅 store，不重复压缩图片） ---------------- */

function dosStamp(d = new Date()) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time: time & 0xffff, date: date & 0xffff };
}

/* CRC32：自己算，避免依赖 node:zlib 的版本差异（zlib.crc32 需要 20.15+） */
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[i] = c;
  }
  return CRC_TABLE;
}

function crcUpdate(crc, buf) {
  const t = crcTable();
  let c = crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

function crcOfFile(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  let crc = 0xffffffff;
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      crc = crcUpdate(crc, buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function copyFileTo(fd, file, size) {
  const src = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  let left = size;
  try {
    while (left > 0) {
      const n = fs.readSync(src, buf, 0, Math.min(buf.length, left), null);
      if (!n) break;
      fs.writeSync(fd, buf, 0, n);
      left -= n;
    }
  } finally {
    fs.closeSync(src);
  }
}

/** entries: [{ name, file, size }] → 写一个 store-only zip */
function writeZip(outPath, entries) {
  const { time, date } = dosStamp();
  const fd = fs.openSync(outPath, 'w');
  const central = [];
  let offset = 0;
  try {
    for (const e of entries) {
      const nameBuf = Buffer.from(e.name, 'utf8');
      const crc = crcOfFile(e.file);
      const head = Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50, 0);
      head.writeUInt16LE(20, 4);
      head.writeUInt16LE(0x0800, 6);   // UTF-8 文件名
      head.writeUInt16LE(0, 8);        // method 0 = store
      head.writeUInt16LE(time, 10);
      head.writeUInt16LE(date, 12);
      head.writeUInt32LE(crc, 14);
      head.writeUInt32LE(e.size, 18);
      head.writeUInt32LE(e.size, 22);
      head.writeUInt16LE(nameBuf.length, 26);
      head.writeUInt16LE(0, 28);
      fs.writeSync(fd, head);
      fs.writeSync(fd, nameBuf);
      copyFileTo(fd, e.file, e.size);

      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0);
      cen.writeUInt16LE(20, 4);
      cen.writeUInt16LE(20, 6);
      cen.writeUInt16LE(0x0800, 8);
      cen.writeUInt16LE(0, 10);
      cen.writeUInt16LE(time, 12);
      cen.writeUInt16LE(date, 14);
      cen.writeUInt32LE(crc, 16);
      cen.writeUInt32LE(e.size, 20);
      cen.writeUInt32LE(e.size, 24);
      cen.writeUInt16LE(nameBuf.length, 28);
      cen.writeUInt16LE(0, 30);       // extra
      cen.writeUInt16LE(0, 32);       // comment
      cen.writeUInt16LE(0, 34);       // disk
      cen.writeUInt16LE(0, 36);       // internal attr
      cen.writeUInt32LE(0x81a40000, 38); // external attr 0644
      cen.writeUInt32LE(offset, 42);
      central.push({ cen, nameBuf });
      offset += 30 + nameBuf.length + e.size;
    }

    const cdStart = offset;
    let cdSize = 0;
    for (const { cen, nameBuf } of central) {
      fs.writeSync(fd, cen);
      fs.writeSync(fd, nameBuf);
      cdSize += 46 + nameBuf.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdStart, 16);
    end.writeUInt16LE(0, 20);
    fs.writeSync(fd, end);
  } finally {
    fs.closeSync(fd);
  }
}

/* ---------------- 自然排序 ---------------- */

function naturalCompare(a, b) {
  const ax = String(a).match(/\d+|\D+/g) || [];
  const bx = String(b).match(/\d+|\D+/g) || [];
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const x = ax[i], y = bx[i];
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d) return d;
    } else if (x !== y) {
      return x.localeCompare(y, 'zh');
    }
  }
  return ax.length - bx.length;
}

/* ---------------- 执行 ---------------- */

const bytes = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const totalImages = chapters.reduce((s, c) => s + c.images.length, 0);
const totalImageBytes = chapters.reduce((s, c) => s + c.images.reduce((t, p) => t + safeSize(p), 0), 0);
function safeSize(p) { try { return fs.statSync(p).size; } catch { return 0; } }

console.log(`\n源目录  ${SRC}`);
console.log(`书名    ${BOOK}`);
console.log(`输出    ${OUT}${opts.dry ? '（只体检，不写文件）' : ''}`);
console.log(`话数    ${chapters.length} 话 · ${totalImages} 张图 · ${bytes(totalImageBytes)}`);
if (passthrough.length) console.log(`已有书  ${passthrough.length} 个文件将被原样搬运`);

if (chapters.length > MAX_PARTS) {
  problems.push(`共 ${chapters.length} 话，超过 App 单本 ${MAX_PARTS} 分段上限；建议按「第1-1000话 / 第1001-2000话」拆开打包，导入后再用「多选合并」并成一本书`);
}
for (const p of passthrough) {
  if (p.size > MAX_FILE) problems.push(`${p.name} 超过 400MB 上限，导入会失败`);
}

if (!opts.dry) fs.mkdirSync(OUT, { recursive: true });

const report = [];
let written = 0, skipped = 0;

for (const c of chapters) {
  const target = path.join(OUT, c.outName);
  const pages = c.images
    .slice()
    .sort((a, b) => naturalCompare(path.basename(a), path.basename(b)));

  if (!opts.dry && fs.existsSync(target) && !opts.force) {
    skipped++;
    report.push({ ...c, target, status: 'skip', size: safeSize(target) });
    continue;
  }

  if (!opts.dry) {
    const entries = pages.map((p, i) => {
      const ext = path.extname(p).toLowerCase();
      const name = `${String(i + 1).padStart(3, '0')}${ext}`;
      return { name, file: p, size: safeSize(p) };
    });
    try {
      writeZip(target, entries);
    } catch (err) {
      problems.push(`${c.outName} 写入失败：${err.message}`);
      continue;
    }
  }
  written++;
  report.push({ ...c, target, status: opts.dry ? 'plan' : 'ok', pages: pages.length, size: safeSize(target) });
}

const moved = [];
if (!opts.dry) {
  for (const p of passthrough) {
    const t = path.join(OUT, p.name);
    if (fs.existsSync(t) && !opts.force) { skipped++; continue; }
    try {
      fs.copyFileSync(p.file, t);
      moved.push({ ...p, target: t, status: 'ok' });
    } catch (err) {
      problems.push(`${p.name} 复制失败：${err.message}`);
    }
  }
} else {
  passthrough.forEach((p) => moved.push({ ...p, status: 'plan' }));
}

/* 传输合集包 */
const bundles = [];
if (opts.bundle > 0 && !opts.dry && written) {
  const okList = report.filter((r) => r.status === 'ok');
  for (let i = 0, idx = 1; i < okList.length; i += opts.bundle, idx++) {
    const group = okList.slice(i, i + opts.bundle);
    if (!group.length) continue;
    const name = `${BOOK}-打包${String(idx).padStart(2, '0')}-${String(opts.bundle)}话.zip`;
    const t = path.join(OUT, name);
    if (fs.existsSync(t) && !opts.force) continue;
    writeZip(t, group.map((g) => ({ name: path.basename(g.target), file: g.target, size: safeSize(g.target) })));
    bundles.push({ name, size: safeSize(t) });
  }
}

/* ---------------- 报告 ---------------- */

console.log('\n目录预览（前 8 条）');
for (const r of report.slice(0, 8)) {
  const tag = r.status === 'skip' ? '已存在' : r.status === 'plan' ? '待生成' : '已生成';
  console.log(`  ${r.outName.padEnd(28)} ${String(r.pages ?? '').padStart(4)} 页  ${tag}`);
}
if (report.length > 8) console.log(`  … 其余 ${report.length - 8} 条`);

if (moved.length) {
  console.log(`\n原样搬运 ${moved.length} 个：`);
  moved.slice(0, 5).forEach((m) => console.log(`  ${m.name}`));
  if (moved.length > 5) console.log(`  … 其余 ${moved.length - 5} 个`);
}

if (bundles.length) {
  console.log(`\n传输包 ${bundles.length} 个：`);
  bundles.forEach((b) => console.log(`  ${b.name}  ${bytes(b.size)}`));
}

if (notes.length) {
  console.log('\n说明');
  notes.forEach((n) => console.log(`  · ${n}`));
}

if (problems.length) {
  console.log('\n需要处理');
  problems.forEach((p) => console.log(`  ! ${p}`));
} else {
  console.log('\n体检通过：无明显格式/体积/数量问题');
}

console.log(`\n结果：生成 ${written} 个 · 跳过 ${skipped} 个 · 输出 ${OUT}`);
if (opts.dry) console.log('这是预演，加 --dry-run 去掉即可真正生成');

if (opts.json) {
  fs.writeFileSync(opts.json, JSON.stringify({
    source: SRC, book: BOOK, out: OUT, digits: opts.digits,
    chapters: report.map((r) => ({ no: r.no, name: r.outName, dir: r.dir, pages: r.pages, status: r.status })),
    passthrough: moved, bundles, problems, notes,
  }, null, 2), 'utf8');
  console.log(`清单已写入 ${opts.json}`);
}
