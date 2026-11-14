"""verify14 — 日漫（RTL）模式点按分区方向

用例：
 1. LTR（默认）：点左侧 → 页码增加？不，LTR 左=prev 减少。先验证 LTR：左点页码减、右点页码增
 2. 切到「右 → 左（日漫）」：右点=prev 减少、左点=next 增加
 3. 切回 LTR 后方向恢复正常
"""
import asyncio
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = "http://127.0.0.1:5178/"

passed, failed = [], []
def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(("PASS" if cond else "FAIL") + " | " + name + (f" ({extra})" if extra and not cond else ""))


def page_no(t):
    m = re.search(r"(\d+)\s*/\s*\d+", t)
    return int(m.group(1)) if m else 0


async def main():
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", headless=True)
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()
        await page.goto(URL, wait_until="networkidle")

        await page.set_input_files("#fileInput", [os.path.join(ROOT, "samples", "夜航.cbz")])
        await page.wait_for_selector(".card", timeout=20000)
        await page.wait_for_timeout(1200)
        await page.locator(".card", has_text="夜航").first.click()
        await page.wait_for_selector("#reader:not([hidden])", timeout=15000)
        await page.wait_for_timeout(1500)

        async def tap(frac):
            await page.mouse.click(1440 * frac, 450)
            await page.wait_for_timeout(700)
            return page_no(await page.locator("#readerPage").inner_text())

        async def set_rtl(on):
            await page.click('[data-r="settings"]')
            await page.wait_for_timeout(400)
            await page.click(f'[data-set="rtl"][data-val="{"1" if on else "0"}"]')
            await page.wait_for_timeout(400)
            await page.click('[data-r="settings"]')  # 关面板
            await page.wait_for_timeout(400)

        # ---- 用例 1：LTR 基线（右=next，左=prev）----
        n0 = await tap(0.90)          # 右点 → 下一页
        n1 = await tap(0.10)          # 左点 → 上一页
        check("LTR：右点进下一页", n0 >= 2, f"page={n0}")
        check("LTR：左点回上一页", n1 == n0 - 1, f"{n1} vs {n0}")

        # ---- 用例 2：RTL（右=prev，左=next）----
        await set_rtl(True)
        r0 = await tap(0.90)          # 右点 → 上一页（RTL 下方向反转）
        r1 = await tap(0.10)          # 左点 → 下一页
        check("RTL：右点=上一页", r1 == r0 + 1, f"{r1} vs {r0}")
        check("RTL：左点=下一页", r1 >= 2 and r1 == r0 + 1, f"page={r1}")

        # ---- 用例 3：切回 LTR 恢复 ----
        await set_rtl(False)
        b0 = await tap(0.90)
        b1 = await tap(0.10)
        check("切回 LTR：右点进下一页", b0 == b1 + 1, f"{b0} vs {b1}")

        await page.keyboard.press("Escape")
        await page.wait_for_timeout(500)
        await browser.close()

    print(f"\n{len(passed)} passed, {len(failed)} failed")
    if failed:
        print("FAILED:", failed)
        sys.exit(1)


asyncio.run(main())
