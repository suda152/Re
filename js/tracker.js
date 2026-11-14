/* ===========================================================
   阅读时长追踪
   - 阅读器打开时每 15 秒记一次心跳，累计进：
     · 当前书的 timeTotal（书上的总时长）
     · 全局按天日志 dayLog（'YYYY-MM-DD' → 当日秒数）
   - 页面切后台（hidden）自动暂停，跨午夜自动分天
   - 每 4 次心跳（约 1 分钟）落库一次，关闭阅读器时再落一次
   =========================================================== */

import { db } from './db.js';

const TICK = 15;          // 单次心跳秒数
const FLUSH_EVERY = 4;    // 每 N 次心跳落库一次

let book = null;
let dayLog = null;        // { '2026-11-14': 320, ... } 惰性加载
let timer = null;
let ticks = 0;
let dirty = false;

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function ensureLog() {
  if (dayLog) return dayLog;
  dayLog = (await db.getPref('readingLog')) || {};
  return dayLog;
}

async function saveLog() {
  if (!dayLog) return;
  await db.setPref('readingLog', dayLog).catch(() => {});
}

async function flush() {
  if (!dirty) return;
  dirty = false;
  await saveLog();
  if (book) await db.putBook({ ...book }).catch(() => {});
}

function tick() {
  if (!book || document.hidden) return;
  book.timeTotal = (book.timeTotal || 0) + TICK;
  const k = todayKey();
  dayLog[k] = (dayLog[k] || 0) + TICK;
  dirty = true;
  if (++ticks % FLUSH_EVERY === 0) flush();
}

// 切后台立刻把已累计的写下来，防止进程被杀丢数据（模块级只挂一次）
document.addEventListener('visibilitychange', () => {
  if (document.hidden && dirty) flush();
}, { passive: true });

/** 阅读器打开后调用；同一本书重复调用无副作用 */
export async function startTracking(b) {
  if (!b) return;
  await ensureLog();
  if (timer) stopTracking();
  book = b;
  ticks = 0;
  dirty = false;
  timer = setInterval(tick, TICK * 1000);
}

/** 阅读器关闭时调用，最后一次落库 */
export async function stopTracking() {
  clearInterval(timer);
  timer = null;
  await flush();
  book = null;
}

/** 全局按天日志（统计页用）；没开过阅读器也能安全调用 */
export async function getDayLog() {
  return ensureLog();
}

/** 汇总：本周（周一起）/ 本月 / 今年 / 全部，秒数 */
export function summarize(log, now = new Date()) {
  const sum = (from) => {
    let s = 0;
    for (const [k, v] of Object.entries(log)) {
      if (!from || k >= from) s += Number(v) || 0;
    }
    return s;
  };
  const pad = (n) => String(n).padStart(2, '0');
  const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const monday = new Date(now);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7)); // 周一为一周起点
  const month = new Date(now.getFullYear(), now.getMonth(), 1);
  const year = new Date(now.getFullYear(), 0, 1);

  return {
    week: sum(dayOf(monday)),
    month: sum(dayOf(month)),
    year: sum(dayOf(year)),
    total: sum(null),
  };
}

/** 近 N 天（默认 7）每天的秒数，按日期升序返回 [{ day, sec }] */
export function recentDays(log, n = 7, now = new Date()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const k = todayKey(d);
    out.push({ day: k, sec: Number(log[k]) || 0 });
  }
  return out;
}
