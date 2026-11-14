"""verify13 — 阅读时长追踪（每本书 / 周 / 月 / 年 / 总）

用例：
 1. 种入已知日志数据 → 统计页四张时长卡数值正确（本周/本月/今年/总计）
 2. 近 7 天柱状图：今天/昨天有条、更早的显示 —
 3. 详情页显示该书的累计阅读时长
 4. 心跳计时：打开书等 ~17 秒，当天日志增加 15 秒、书的 timeTotal 增加
 5. 切后台暂停：document.hidden 覆写后心跳不再累计
"""
import asyncio
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = "http://127.0.0.1:5178/"
TODAY = __import__("datetime").date.today().isoformat()
YDAY = __import__("datetime").date.fromordinal(__import__("datetime").date.today().toordinal() - 1).isoformat()

passed, failed = [], []
def check(name, cond):
    (passed if cond else failed).append(name)
    print(("PASS" if cond else "FAIL") + " | " + name)

SEED_LOG = {
    TODAY: 600,          # 本周
    YDAY: 1200,          # 本周
    "2026-11-03": 3600,  # 上周一 → 计入今年、不计入本周
    "2026-10-05": 7200,  # 上月 → 计入今年
    "2025-12-31": 36000, # 去年 → 只计入总计
}
# 期望值（2026-11-14 周六，周一起点 11-10；11-03 同时属于本月）
WEEK = 1800      # 30 分钟
MONTH = 5400     # 1.5 小时（今天+昨天+11-03）
YEAR = 12600     # 3.5 小时
TOTAL = 48600    # 13.5 小时


async def state_of(page, book_id):
    return await page.evaluate("""async (id) => {
      const { state } = await import('/js/state.js');
      const b = state.books.find(x => x.id === id);
      return b ? { title: b.title, timeTotal: b.timeTotal || 0 } : null;
    }""", book_id)


async def main():
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", headless=True)
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()
        await page.goto(URL, wait_until="networkidle")

        # 导入一本 txt 当测试书
        await page.set_input_files("#fileInput", [os.path.join(ROOT, "samples", "长夜手记.txt")])
        await page.wait_for_selector(".card", timeout=20000)
        await page.wait_for_timeout(1000)
        book_id = await page.locator(".card").first.get_attribute("data-id")

        # 给书种 timeTotal，种日志
        await page.evaluate("""async ([id, log]) => {
          const { db } = await import('/js/db.js');
          const b = await db.getBook(id);
          b.timeTotal = 10200;           // 2 小时 50 分
          b.lastReadAt = Date.now();
          await db.putBook(b);
          await db.setPref('readingLog', log);
        }""", [book_id, SEED_LOG])
        await page.reload(wait_until="networkidle")
        await page.wait_for_timeout(600)

        # ---- 用例 1：统计页四张时长卡 ----
        await page.click('.nav-item[data-view="stats"]')
        await page.wait_for_selector("#timeGrid .stat")
        cards = await page.evaluate("""() => [...document.querySelectorAll('#timeGrid .stat')]
          .map(s => `${s.querySelector('span').textContent}|${s.querySelector('strong').textContent}`)""")
        check("本周卡 30 分钟", "本周|30分钟" in cards)
        check("本月卡 1.5 小时", "本月|1.5小时" in cards)
        check("今年卡 3.5 小时", "今年|3.5小时" in cards)
        check("总时长卡 13.5 小时", "总时长|13.5小时" in cards)

        # ---- 用例 2：近 7 天 ----
        bars = await page.evaluate("""() => [...document.querySelectorAll('#dayBars .bar-row')]
          .map(r => `${r.querySelector('span').textContent}|${r.querySelector('em').textContent}`)""")
        today_row = next((b for b in bars if b.startswith("今天|")), None)
        check("近7天含今天 10 分钟", today_row == "今天|10 分钟")
        check("近7天含昨天 20 分钟", any(b.startswith(("昨天", "11/13")) and "20 分钟" in b for b in bars))
        check("更早的天显示 —", sum(1 for b in bars if b.endswith("|—")) == 5)

        # ---- 用例 3：详情页累计时长 ----
        await page.click('.nav-item[data-view="library"]')
        await page.locator(".card").first.click(button="right")
        await page.wait_for_selector("#ctxMenu:not([hidden])")
        await page.locator('#ctxMenu [data-act="detail"]').click()
        await page.wait_for_selector("#detailDialog[open]")
        detail = await page.evaluate("""() => [...document.querySelectorAll('#detailMeta div')]
          .map(d => d.querySelector('dt').textContent + ':' + d.querySelector('dd').textContent)""")
        check("详情页显示 累计阅读 2 小时 50 分", any(d == "累计阅读:2 小时 50 分" for d in detail))
        await page.keyboard.press("Escape")

        # ---- 用例 4：真实心跳计时 ----
        await page.evaluate("""async () => {
          const { db } = await import('/js/db.js');
          await db.setPref('readingLog', {});
        }""")
        await page.reload(wait_until="networkidle")
        await page.wait_for_timeout(600)
        before = await state_of(page, book_id)
        await page.evaluate("""async (id) => {
          const { emit } = await import('/js/state.js');
          emit('open-book', id);
        }""", book_id)
        await page.wait_for_selector("#reader:not([hidden])", timeout=15000)
        await page.wait_for_timeout(17000)  # 至少一个 15s 心跳
        after = await state_of(page, book_id)
        log_now = await page.evaluate("""async () => {
          const { db } = await import('/js/db.js');
          return await db.getPref('readingLog');
        }""")
        gained = (after["timeTotal"] or 0) - (before["timeTotal"] or 0)
        check("心跳累计了时长（约15秒）", 10 <= gained <= 40)
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(600)  # 关闭阅读器触发最后一次落库
        log_now = await page.evaluate("""async () => {
          const { db } = await import('/js/db.js');
          return await db.getPref('readingLog');
        }""")
        check("当天日志已落库", (log_now or {}).get(TODAY, 0) >= 15)

        # ---- 用例 5：hidden 时暂停 ----
        await page.evaluate("""async (id) => {
          Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
        }""", book_id)
        h0 = await state_of(page, book_id)
        await page.evaluate("""async (id) => {
          const { emit } = await import('/js/state.js');
          emit('open-book', id);
        }""", book_id)
        await page.wait_for_selector("#reader:not([hidden])", timeout=15000)
        await page.wait_for_timeout(17000)
        h1 = await state_of(page, book_id)
        check("后台标签页不再累计", h1["timeTotal"] <= h0["timeTotal"] + 5)
        await page.evaluate("Object.defineProperty(document, 'hidden', { get: () => false, configurable: true })")

        # 截图
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(500)
        await page.click('.nav-item[data-view="stats"]')
        await page.wait_for_timeout(600)
        await page.screenshot(path=os.path.join(ROOT, "..", "..", "verify-shots", "time-01-stats.png"))

        await browser.close()

    print(f"\n{len(passed)} passed, {len(failed)} failed")
    if failed:
        print("FAILED:", failed)
        sys.exit(1)


asyncio.run(main())
