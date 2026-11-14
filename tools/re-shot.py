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

        files = [os.path.join(ROOT, "samples", n) for n in ("星轨列车.epub", "夜航.cbz", "长夜手记.txt")]
        await page.set_input_files("#fileInput", files)
        await page.wait_for_selector(".card", timeout=20000)
        await page.wait_for_timeout(2000)
        await page.screenshot(path=os.path.join(SHOTS, "re-01-shelf.png"))

        # 切到统计板块（触发滑动动画后的落定状态）
        await page.locator(".nav-item[data-view='stats']").click()
        await page.wait_for_timeout(400)
        await page.screenshot(path=os.path.join(SHOTS, "re-02-stats.png"))

        # 合并重命名验证：导入两个同系列不同卷号的文件并合并，检查书名
        await page.evaluate("""
          const part = (name) => new File([new Blob([x='x'.repeat(900)])], name);
          const dt = new DataTransfer();
          ['星轨列车 第01话.cbz','星轨列车 第02话.cbz'].forEach(n => dt.items.add(part(n)));
          const input = document.querySelector('#fileInput');
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        """)
        await page.wait_for_timeout(2500)
        titles = await page.evaluate("[...document.querySelectorAll('.card-title')].map(e=>e.textContent)")
        print("TITLES:", titles)
        await browser.close()

asyncio.run(main())
