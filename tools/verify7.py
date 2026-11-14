"""滑动选中 / 一键全选 / 合并结果按章节展示 校验

本机 Edge（无 GPU）连续 CDP 交互后坐标输入会失效，因此手势用 PointerEvent 派发，
走的仍是页面里同一套 pointerdown/pointermove/pointerup 处理器；
真实鼠标命中栈单独断言。
"""
import asyncio
import os
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARTS = os.path.join(ROOT, "samples", "parts")
SHOTS = os.path.join(os.path.dirname(ROOT.rstrip("\\/")), "verify-shots")
URL = "http://127.0.0.1:5178/"

FILES = ["夜行.cbz", "孤岛.cbz", "旧站.cbz", "夜航 01.cbz"]

ok = True
errors = []


def check(name, cond, detail=""):
    global ok
    print(("PASS " if cond else "FAIL ") + name + (f" -> {detail}" if detail else ""))
    ok = ok and bool(cond)


async def shot(page, name):
    os.makedirs(SHOTS, exist_ok=True)
    await page.screenshot(path=os.path.join(SHOTS, name))


async def frame(page):
    """等两帧，让 rAF 里的选中刷新落地"""
    await page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")
    await page.wait_for_timeout(120)


async def sel_count(page):
    return await page.evaluate("document.querySelectorAll('.card.selected').length")


PT = """(x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y,
        pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, isPrimary: true })"""


async def pointer(page, kind, x, y, target="window"):
    await page.evaluate(
        f"""([kind, x, y, target]) => {{
            const opt = ({PT})(x, y);
            const el = target === 'card0'
              ? document.querySelectorAll('.card')[0]
              : window;
            el.dispatchEvent(new PointerEvent(kind, opt));
        }}""",
        [kind, x, y, target],
    )
    await frame(page)


async def center(page, idx):
    return await page.evaluate(
        """(i) => {
            const c = document.querySelectorAll('.card')[i].getBoundingClientRect();
            return [c.left + c.width / 2, c.top + c.height / 2];
        }""",
        idx,
    )


async def drag_start(page, idx):
    x, y = await center(page, idx)
    await pointer(page, "pointerdown", x, y, "card0")
    return x, y


async def drag_move(page, idx):
    x, y = await center(page, idx)
    await pointer(page, "pointermove", x, y)
    return x, y


async def drag_end(page, x, y):
    await pointer(page, "pointerup", x, y)


async def click_sel(page, sel):
    """本机 Edge 连续 CDP 交互后坐标输入会失效，统一用事件派发点按钮"""
    await page.evaluate(
        "(sel) => { const el = document.querySelector(sel); if (!el) throw new Error('missing ' + sel); el.click(); }",
        sel,
    )
    await frame(page)


async def press_esc(page):
    await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))")
    await frame(page)


async def card_titles(page):
    return await page.evaluate("[...document.querySelectorAll('.card .card-title')].map((e) => e.textContent)")


async def main():
    global errors
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge")
        page = await browser.new_page(viewport={"width": 1280, "height": 900})
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        await page.goto(URL)
        await page.evaluate("() => new Promise((r) => { const q = indexedDB.deleteDatabase('yice'); q.onsuccess = q.onerror = q.onblocked = r; })")
        await page.reload()
        await page.wait_for_timeout(600)

        # ---------- 导入 4 本互不相同（互不归并）的漫画 ----------
        await page.set_input_files("#fileInput", [os.path.join(PARTS, f) for f in FILES])
        await page.wait_for_timeout(2200)
        n = await page.evaluate("document.querySelectorAll('.card').length")
        check("导入 4 本独立漫画", n == 4, f"{n} 张卡片")

        # ---------- 既有逻辑回归：Ctrl 点选 / Shift 连选 / Esc 退出 ----------
        await click_sel(page, "#btnSelect")
        await frame(page)
        await page.evaluate("document.querySelectorAll('.card')[1].dispatchEvent(new MouseEvent('click', {bubbles:true}))")
        await frame(page)
        check("单击进入多选后选中 1 本", await sel_count(page) == 1)
        await page.evaluate("document.querySelectorAll('.card')[3].dispatchEvent(new MouseEvent('click', {bubbles:true, ctrlKey:true}))")
        await frame(page)
        check("Ctrl 点击仍是加减选", await sel_count(page) == 2)
        await page.evaluate("document.querySelectorAll('.card')[0].dispatchEvent(new MouseEvent('click', {bubbles:true, shiftKey:true}))")
        await frame(page)
        # 锚点是上一次点到的第 4 本，Shift 点第 1 本 → 1~4 全选
        check("Shift 点击仍是连选（锚点→点击处）", await sel_count(page) == 4, f"{await sel_count(page)}")
        await press_esc(page)
        await frame(page)
        check("Esc 退出多选", await sel_count(page) == 0 and await page.locator("#selectBar").is_hidden())

        # ---------- 拖动连续选中 ----------
        await click_sel(page, "#btnSelect")
        await frame(page)
        check("多选时顶栏出现一键全选", await page.locator("#btnSelectAll").is_visible())
        check("多选时出现滑动提示", await page.locator("#shelfHint").is_visible())

        x0, y0 = await drag_start(page, 0)
        check("刚按下还没选中（点选逻辑不变）", await sel_count(page) == 0)
        await drag_move(page, 1)
        check("拖过第 2 本：连续选中 2 本", await sel_count(page) == 2, f"{await sel_count(page)}")
        await drag_move(page, 3)
        check("拖到第 4 本：连续选中 4 本", await sel_count(page) == 4, f"{await sel_count(page)}")
        check("拖动时卡片进入拖选态", await page.evaluate("document.querySelector('#shelf').classList.contains('dragging')"))
        await shot(page, "v7-drag.png")

        await drag_move(page, 1)
        check("拖回第 2 本：范围回缩为 2 本", await sel_count(page) == 2, f"{await sel_count(page)}")
        x1, y1 = await center(page, 1)
        await drag_end(page, x1, y1)
        await page.evaluate("document.querySelectorAll('.card')[0].dispatchEvent(new MouseEvent('click', {bubbles:true}))")
        await frame(page)
        check("松手后补发的 click 不会翻转选中", await sel_count(page) == 2, f"{await sel_count(page)}")

        # 从已选中的卡片起手 = 划掉
        await drag_start(page, 0)
        await drag_move(page, 1)
        await drag_end(page, *await center(page, 1))
        check("从已选卡片起手拖动是取消选中", await sel_count(page) == 0, f"{await sel_count(page)}")

        # ---------- 一键全选 ----------
        await click_sel(page, "#btnSelectAll")
        await frame(page)
        total = await page.evaluate("document.querySelectorAll('.card').length")
        check("顶栏一键全选全部选中", await sel_count(page) == total, f"{await sel_count(page)}/{total}")
        check("全选后按钮变取消全选", "取消全选" in await page.locator("#btnSelectAll").inner_text())
        await click_sel(page, "#btnSelectAll")
        await frame(page)
        check("再点一次取消全选", await sel_count(page) == 0)
        await click_sel(page, "#selectAll")
        await frame(page)
        check("底栏全选同样可用", await sel_count(page) == total)

        # ---------- 合并并检查结果展示 ----------
        await click_sel(page, "#selectMerge")
        await page.wait_for_timeout(300)
        check("合并对话框打开", await page.locator("#mergeDialog").is_visible())
        await click_sel(page, "#mergeOk")
        await page.wait_for_timeout(900)

        check("合并后弹出结果面板", await page.locator("#mergeResultDialog").is_visible())
        rows = await page.evaluate("document.querySelectorAll('#mergeResultList li').length")
        check("结果按章节逐条列出（4 章）", rows == 4, f"{rows} 条")
        lead = await page.locator("#mergeResultLead").inner_text()
        check("结果文案说明共几章", "4 章" in lead, lead)
        first = await page.locator("#mergeResultList li").first.inner_text()
        check("章节带序号与页码", "第 1 章" in first and "页" in first, first.replace("\n", " | "))
        news = await page.evaluate("document.querySelectorAll('#mergeResultList li.new').length")
        check("新并入的章节高亮（3 条）", news == 3, f"{news} 条")
        check("有页码范围 / 分页信息", await page.evaluate(
            "[...document.querySelectorAll('#mergeResultList li b')].every((b) => /\\d+\\s*页/.test(b.textContent))"))
        await shot(page, "v7-merge-result.png")

        await click_sel(page, "#mergeResultClose")
        await page.wait_for_timeout(300)
        n = await page.evaluate("document.querySelectorAll('.card').length")
        meta = await page.locator(".card .card-meta span").first.inner_text()
        check("合并后书架只剩 1 本", n == 1, f"{n} 张")
        check("书架体量按章显示而不是只报页数", "4 章" in meta and "页" in meta, meta)

        # ---------- 详情里的章节列表 ----------
        await page.evaluate("document.querySelector('.card').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, clientX:400, clientY:300}))")
        await page.wait_for_timeout(250)
        await page.evaluate("document.querySelector('#ctxMenu [data-act=\"detail\"]').click()")
        await page.wait_for_timeout(400)
        check("详情对话框打开", await page.locator("#detailDialog").is_visible())
        check("详情显示章节块", await page.locator("#detailChapters").is_visible())
        dcn = await page.evaluate("document.querySelectorAll('#detailChapters .dc-list li').length")
        check("详情章节 4 条", dcn == 4, f"{dcn} 条")
        check("详情章节有名称", "第 2 章" in await page.locator("#detailChapters").inner_text())
        await shot(page, "v7-detail.png")
        await page.evaluate("document.querySelector('#detailDialog').close()")
        await page.wait_for_timeout(200)

        # ---------- 阅读器目录按章 ----------
        await page.evaluate("document.querySelector('.card').dispatchEvent(new MouseEvent('click', {bubbles:true}))")
        await page.wait_for_timeout(1600)
        check("点卡片仍能打开阅读器", await page.locator("#reader").is_visible())
        await page.evaluate("document.querySelector('[data-r=\"toc\"]').click()")
        await page.wait_for_timeout(500)
        toc = await page.evaluate("document.querySelectorAll('.toc-item.chapter').length")
        check("漫画目录按章列出（4 章）", toc == 4, f"{toc} 条")
        sub = await page.locator(".toc-item .sub").first.inner_text()
        check("目录每章标出页码范围", "页" in sub and "–" in sub, sub)
        label = await page.locator("#readerPage").inner_text()
        check("进度标签带章节名", "第 1 章" in label, label)
        await shot(page, "v7-toc.png")

        # 跳章
        await page.evaluate("document.querySelectorAll('.toc-item')[2].click()")
        await page.wait_for_timeout(900)
        label2 = await page.locator("#readerPage").inner_text()
        check("目录跳到第 3 章", "第 3 章" in label2, label2)

        # ---------- 窄屏：底栏全选被隐藏时，顶栏一键全选仍可用 ----------
        await page.evaluate("document.querySelector('[data-r=\"close\"]').click()")
        await page.wait_for_timeout(700)
        await page.set_viewport_size({"width": 600, "height": 900})
        await frame(page)
        await click_sel(page, "#btnSelect")
        check("600px 下底栏全选让位隐藏", await page.locator("#selectAll").is_hidden())
        check("600px 下顶栏一键全选可见", await page.locator("#btnSelectAll").is_visible())
        await page.evaluate("document.querySelector('.card').dispatchEvent(new MouseEvent('click', {bubbles:true}))")
        await frame(page)
        check("窄屏也能选中", await sel_count(page) == 1)
        await shot(page, "v7-narrow.png")
        await press_esc(page)

        # ---------- 控制台干净 ----------
        real = [e for e in errors if "favicon" not in e.lower()]
        check("无控制台报错", not real, real[:3])

        await browser.close()

    print("\n" + ("ALL PASS" if ok else "SOME FAILED"))
    print(f"{len(errors)} console errors")


asyncio.run(main())
