import asyncio, os
from playwright.async_api import async_playwright

ROOT = r"D:\agentwork\wb\spaces\2026_11_13_19-50-55\tome-app"
SHOTS = r"D:\agentwork\wb\spaces\2026_11_13_19-50-55\verify-shots"
os.makedirs(SHOTS, exist_ok=True)
URL = "http://127.0.0.1:5178/"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", headless=True)
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()
        await page.goto(URL, wait_until="networkidle")
        await page.wait_for_timeout(600)
        await page.screenshot(path=os.path.join(SHOTS, "swiss-01-light-empty.png"))

        # 导入样例看看非空书架
        files = [os.path.join(ROOT, "samples", n) for n in ("星轨列车.epub", "夜航.cbz", "长夜手记.txt")]
        await page.set_input_files("#fileInput", files)
        await page.wait_for_selector(".card", timeout=20000)
        await page.wait_for_timeout(2000)
        await page.screenshot(path=os.path.join(SHOTS, "swiss-02-light-shelf.png"))

        # 详情对话框（直角卡片）
        await page.locator(".card-more").first.click(force=True)
        await page.wait_for_timeout(300)
        # more 打开的是右键菜单，点「详情」类第一项
        try:
            await page.locator("#ctxMenu button").first.click()
            await page.wait_for_selector("#detailDialog[open]", timeout=3000)
            await page.wait_for_timeout(400)
            await page.screenshot(path=os.path.join(SHOTS, "swiss-03-detail.png"))
            await page.keyboard.press("Escape")
        except Exception as e:
            print("detail skip:", e)

        # 深色主题
        await page.evaluate("document.documentElement.setAttribute('data-theme','dark')")
        await page.wait_for_timeout(500)
        await page.screenshot(path=os.path.join(SHOTS, "swiss-04-dark-shelf.png"))

        # 设置页（面板+分段控件）
        await page.evaluate("document.documentElement.setAttribute('data-theme','light')")
        await page.locator(".nav-item[data-view='settings']").click()
        await page.wait_for_timeout(500)
        await page.screenshot(path=os.path.join(SHOTS, "swiss-05-settings.png"))

        await browser.close()
        print("SHOTS_OK")

asyncio.run(main())
