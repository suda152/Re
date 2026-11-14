import asyncio, os
from playwright.async_api import async_playwright
ROOT = r"D:/agentwork/wb/spaces/2026_11_13_19-50-55/tome-app"
SHOTS = r"D:/agentwork/wb/spaces/2026_11_13_19-50-55/verify-shots"
URL = "http://127.0.0.1:5178/"
ok = True
def check(n, c, d=""):
    global ok
    print(("PASS " if c else "FAIL ") + n + (f" -> {d}" if d else ""))
    ok = ok and bool(c)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="msedge", headless=True)
        ctx = await b.new_context(viewport={"width":1440,"height":900})
        page = await ctx.new_page()
        errs=[]
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.goto(URL, wait_until="networkidle")
        await page.set_input_files("#fileInput", [os.path.join(ROOT,"samples","长夜手记.txt")])
        await page.wait_for_selector(".card", timeout=20000); await page.wait_for_timeout(1500)
        # 详情
        await page.locator(".card").first.click(button="right"); await page.wait_for_timeout(400)
        await page.click("#ctxMenu [data-act='detail']"); await page.wait_for_timeout(500)
        check("详情弹窗打开", await page.locator("#detailDialog").is_visible())
        check("详情显示章数", "4" in await page.locator("#detailMeta").inner_text(), await page.locator("#detailMeta").inner_text())
        await page.screenshot(path=os.path.join(SHOTS,"28-detail.png"))
        await page.keyboard.press("Escape"); await page.wait_for_timeout(300)
        # 打开 txt
        await page.locator(".card").first.click(); await page.wait_for_timeout(1500)
        lbl = await page.locator("#readerPage").inner_text()
        check("TXT 可阅读", "开始" in lbl or "第一章" in lbl, lbl)
        n = await page.evaluate("document.querySelector('.epub-flow')?.innerText.length")
        check("TXT 有内容", (n or 0) > 40, n)
        await page.screenshot(path=os.path.join(SHOTS,"29-txt-reader.png"))
        await page.keyboard.press("ArrowRight"); await page.wait_for_timeout(900)
        check("TXT 翻页", await page.locator("#readerPage").inner_text() != lbl, await page.locator("#readerPage").inner_text())
        await page.keyboard.press("Escape"); await page.wait_for_timeout(700)
        # 标记未读
        await page.locator(".card").first.click(button="right"); await page.wait_for_timeout(400)
        await page.click("#ctxMenu [data-act='reset']"); await page.wait_for_timeout(700)
        meta = await page.locator(".card .card-meta").first.inner_text()
        check("标记未读清除进度", "%" not in meta, meta)
        print("errors:", errs[:3])
        await b.close()
asyncio.run(main())
