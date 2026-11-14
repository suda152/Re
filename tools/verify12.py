# 换封面用例：详情页入口 → 书内选图网格 → 选第2张 → 封面更新且持久化；入口按类型显隐
import asyncio, os, sys

ROOT = r"D:\agentwork\wb\spaces\2026_11_13_19-50-55\tome-app"
SHOTS = r"D:\agentwork\wb\spaces\2026_11_13_19-50-55\verify-shots"
URL = "http://127.0.0.1:5178/"

passed, failed = [], []

def check(name, cond, detail=""):
    (passed if cond else failed).append(name)
    print(("PASS" if cond else "FAIL") + " | " + name + (f" ({detail})" if detail else ""))

async def state_of(page):
    return await page.evaluate("""async () => {
      const { state } = await import('/js/state.js');
      const b = state.books.find(x => x.type === 'comic');
      if (!b) return null;
      return { title: b.title, cover: b.cover || '', coverDerived: !!b.coverDerived,
               parts: b.parts.length, count: b.count || 0 };
    }""")

async def main():
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", headless=True)
        page = await (await browser.new_context(viewport={"width": 1440, "height": 900})).new_page()
        await page.goto(URL, wait_until="networkidle")
        await page.wait_for_timeout(600)

        await page.set_input_files("#fileInput", [os.path.join(ROOT, "samples", "夜航.cbz")])
        await page.wait_for_selector(".card", timeout=20000)
        await page.wait_for_timeout(1500)

        # epub 不应显示换封面按钮
        await page.set_input_files("#fileInput", [os.path.join(ROOT, "samples", "星轨列车.epub")])
        await page.wait_for_timeout(1500)

        # 右键漫画 → 详情 → 换封面可见
        comic_card = page.locator(".card").filter(has=page.locator(f"text=夜航")).first
        await comic_card.click(button="right")
        await page.wait_for_selector("#ctxMenu:not([hidden])")
        await page.locator('#ctxMenu [data-act="detail"]').click()
        await page.wait_for_selector("#detailDialog[open]")
        check("漫画详情显示换封面按钮", await page.locator("#detailCoverChange").is_visible())
        await page.click("#detailCoverChange")
        await page.wait_for_selector("#coverDialog[open]")

        # 候选网格：单文件 cbz 走解包取页路径
        n = await page.locator("#coverGrid button").count()
        check("候选图已列出（≥2）", n >= 2, f"{n} 张")
        await page.screenshot(path=os.path.join(SHOTS, "cover-01-grid.png"))

        before = await state_of(page)
        await page.locator("#coverGrid button").nth(1).click()
        await page.wait_for_timeout(900)

        after = await state_of(page)
        check("封面已换且不再是占位", after and after["cover"] != before["cover"] and not after["coverDerived"])
        check("封面是书内图片(dataURL)", after and after["cover"].startswith("data:image"))

        # 刷新持久化
        await page.reload(wait_until="networkidle")
        await page.wait_for_timeout(800)
        kept = await state_of(page)
        check("刷新后封面保留", kept and kept["cover"] == after["cover"])

        # epub 详情不应有换封面
        await page.locator(".card").filter(has=page.locator(f"text=星轨列车")).first.click(button="right")
        await page.wait_for_selector("#ctxMenu:not([hidden])")
        await page.locator('#ctxMenu [data-act="detail"]').click()
        await page.wait_for_selector("#detailDialog[open]")
        check("epub 详情隐藏换封面按钮", await page.locator("#detailCoverChange").is_hidden())
        await page.keyboard.press("Escape")

        await browser.close()

    print(f"\n== {len(passed)} passed, {len(failed)} failed ==")
    sys.exit(1 if failed else 0)

asyncio.run(main())
