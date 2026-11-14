# 编辑书名/作者功能用例：右键菜单与详情页两条入口 + 持久化 + 占位封面更新
import asyncio, os, sys

ROOT = r"D:\agentwork\wb\spaces\2026_11_13_19-50-55\tome-app"
SHOTS = r"D:\agentwork\wb\spaces\2026_11_13_19-50-55\verify-shots"
URL = "http://127.0.0.1:5178/"

passed, failed = [], []

def check(name, cond):
    (passed if cond else failed).append(name)
    print(("PASS" if cond else "FAIL") + " | " + name)

async def state_of(page, card_id):
    return await page.evaluate(
        """async (id) => {
          const { state } = await import('/js/state.js');
          const b = state.books.find(x => x.id === id);
          return b ? { title: b.title, author: b.author || '', cover: b.cover || '',
                       coverDerived: !!b.coverDerived, series: JSON.stringify(b.series || null) } : null;
        }""", card_id)

async def open_detail_via_menu(page):
    await page.locator(".card").first.click(button="right")
    await page.wait_for_selector("#ctxMenu:not([hidden])")
    await page.locator('#ctxMenu [data-act="detail"]').click()
    await page.wait_for_selector("#detailDialog[open]")

async def main():
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", headless=True)
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()
        await page.goto(URL, wait_until="networkidle")
        await page.wait_for_timeout(600)

        # 导入一本 txt（占位封面 coverDerived=true）
        await page.set_input_files("#fileInput", [os.path.join(ROOT, "samples", "长夜手记.txt")])
        await page.wait_for_selector(".card", timeout=20000)
        await page.wait_for_timeout(1200)

        card = page.locator(".card").first
        card_id = await card.get_attribute("data-id")
        before = await state_of(page, card_id)

        # ---- 用例 1：右键菜单入口，改书名+作者 ----
        await card.click(button="right")
        await page.wait_for_selector("#ctxMenu:not([hidden])")
        menu_has_edit = await page.locator('#ctxMenu [data-act="edit"]').count()
        check("右键菜单含「编辑书名/作者」", menu_has_edit == 1)
        await page.locator('#ctxMenu [data-act="edit"]').click()
        await page.wait_for_selector("#editDialog[open]")
        t0 = await page.input_value("#editTitle")
        check("弹窗预填原书名", t0.strip() != "")
        await page.fill("#editTitle", "镜与深渊")
        await page.fill("#editAuthor", "青山尾上")
        await page.click("#editOk")
        await page.wait_for_timeout(800)

        info = await state_of(page, card_id)
        check("state 书名已更新", info["title"] == "镜与深渊")
        check("state 作者已更新", info["author"] == "青山尾上")
        card_title = await page.locator(".card-title").first.text_content()
        check("卡片标题同步", card_title.strip() == "镜与深渊")
        check("占位封面已重新生成", info["cover"] != before["cover"] and info["cover"].startswith("data:image/svg"))
        check("series 随新名重推导", info["series"] != before["series"] or info["series"] == "null")

        # ---- 用例 2：详情页入口，只改作者 ----
        await open_detail_via_menu(page)
        has_btn = await page.locator("#detailEdit").count()
        check("详情页有「编辑信息」按钮", has_btn == 1)
        await page.click("#detailEdit")
        await page.wait_for_selector("#editDialog[open]")
        check("详情打开的弹窗预填新书名", (await page.input_value("#editTitle")) == "镜与深渊")
        await page.fill("#editAuthor", "新川")
        await page.click("#editOk")
        await page.wait_for_timeout(800)
        author2 = (await state_of(page, card_id))["author"]
        check("作者二次修改生效", author2 == "新川")

        # ---- 用例 3：空书名被拒 ----
        await page.locator(".card").first.click(button="right")
        await page.wait_for_selector("#ctxMenu:not([hidden])")
        await page.locator('#ctxMenu [data-act="edit"]').click()
        await page.wait_for_selector("#editDialog[open]")
        await page.fill("#editTitle", "   ")
        await page.click("#editOk")
        await page.wait_for_timeout(400)
        still_open = await page.evaluate("document.querySelector('#editDialog').open")
        t_keep = (await state_of(page, card_id))["title"]
        check("空书名被拒且弹窗未关", still_open and t_keep == "镜与深渊")
        await page.click("#editCancel")
        await page.wait_for_timeout(300)

        # ---- 用例 4：改名后持久化（刷新仍在）+ 作者可搜索 ----
        await page.reload(wait_until="networkidle")
        await page.wait_for_timeout(800)
        after = await state_of(page, card_id)
        check("刷新后书名/作者保留", after["title"] == "镜与深渊" and after["author"] == "新川")

        search = page.locator("#search")
        if await search.count():
            await search.fill("新川")
            await page.wait_for_timeout(500)
            visible = await page.locator(".card").count()
            check("按作者可搜到书", visible == 1)
            await search.fill("")
            await page.wait_for_timeout(400)

        # 详情页展示同步
        await open_detail_via_menu(page)
        dt = await page.text_content("#detailTitle")
        da = await page.text_content("#detailAuthor")
        check("详情页展示新名/作者", dt.strip() == "镜与深渊" and da.strip() == "新川")
        await page.keyboard.press("Escape")

        await page.screenshot(path=os.path.join(SHOTS, "edit-01-shelf.png"))
        await browser.close()

    print(f"\n== {len(passed)} passed, {len(failed)} failed ==")
    sys.exit(1 if failed else 0)

asyncio.run(main())
