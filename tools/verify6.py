"""多选合并校验：Ctrl/Shift 选择、操作条、合并对话框、类型拦截、合并后可读

说明：本机 Edge（无 GPU，SwiftShader）在某些交互之后会把后续 CDP 鼠标坐标输入丢掉，
表现为点击不产生任何 DOM 事件（elementFromPoint 与命中栈却完全正常）。
因此业务流程用事件派发驱动（走的是同一套事件处理器与冒泡），
同时单独断言「目标元素位于命中栈顶层且 pointer-events 为 auto」，覆盖真实点击可达性。
"""
import asyncio
import os
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARTS = os.path.join(ROOT, "samples", "parts")
SHOTS = os.path.join(os.path.dirname(ROOT.rstrip("\\/")), "verify-shots")
URL = "http://127.0.0.1:5178/"

ok = True


def check(name, cond, detail=""):
    global ok
    print(("PASS " if cond else "FAIL ") + name + (f" -> {detail}" if detail else ""))
    ok = ok and bool(cond)


async def shot(page, name):
    os.makedirs(SHOTS, exist_ok=True)
    await page.screenshot(path=os.path.join(SHOTS, name))


async def fire(page, selector, event="click", **opts):
    await page.evaluate(
        """([sel, ev, opts]) => {
            const el = document.querySelector(sel);
            if (!el) throw new Error('missing ' + sel);
            el.dispatchEvent(new MouseEvent(ev, Object.assign({ bubbles: true, cancelable: true }, opts)));
        }""",
        [selector, event, opts],
    )
    await page.wait_for_timeout(220)


async def card_fire(page, title, ctrl=False, shift=False, event="click"):
    await page.evaluate(
        """([t, ctrl, shift, ev]) => {
            const card = [...document.querySelectorAll('.card')]
              .find((c) => c.querySelector('.card-title').textContent.includes(t));
            if (!card) throw new Error('no card ' + t);
            card.dispatchEvent(new MouseEvent(ev, {
              bubbles: true, cancelable: true, ctrlKey: ctrl, shiftKey: shift,
            }));
        }""",
        [title, ctrl, shift, event],
    )
    await page.wait_for_timeout(220)


async def selected_count(page):
    return await page.evaluate("document.querySelectorAll('.card.selected').length")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="msedge", headless=True)
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)

        await page.goto(URL, wait_until="networkidle")
        files = [os.path.join(PARTS, n) for n in ("孤岛.cbz", "旧站.cbz", "夜行.cbz", "短歌.epub")]
        await page.set_input_files("#fileInput", files)
        await page.wait_for_selector(".card", timeout=20000)
        await page.wait_for_timeout(2500)
        check("导入 4 本独立书籍", await page.locator(".card").count() == 4,
              await page.locator(".card").count())

        # 0) 顶栏「多选」入口（触屏没有 Ctrl 键）
        await fire(page, "#btnSelect")
        check("顶栏多选按钮进入模式", await page.locator("#selectBar").is_visible())
        check("空选时合并按钮禁用", not await page.locator("#selectMerge").is_enabled())
        check("空选时提示点选", "点选" in await page.locator("#selectNote").inner_text(),
              await page.locator("#selectNote").inner_text())
        check("进入模式后卡片露出勾选圈",
              await page.evaluate("document.querySelector('#shelf').classList.contains('selecting')"))
        await card_fire(page, "夜行")
        check("模式内单击即选中", await selected_count(page) == 1, await selected_count(page))
        await fire(page, "#selectCancel")
        check("取消退出多选模式",
              await page.locator("#selectBar").is_hidden() and await selected_count(page) == 0)
        check("顶栏按钮取消激活",
              not await page.evaluate("document.querySelector('#btnSelect').classList.contains('active')"))

        # 1) Ctrl 多选
        await card_fire(page, "孤岛", ctrl=True)
        check("Ctrl 点选后出现操作条", await page.locator("#selectBar").is_visible())
        await card_fire(page, "旧站", ctrl=True)
        check("已选计数为 2", await page.locator("#selectCount").inner_text() == "2",
              await page.locator("#selectCount").inner_text())
        check("选中态写到卡片上", await selected_count(page) == 2, await selected_count(page))
        check("合并按钮可用", await page.locator("#selectMerge").is_enabled())
        note = await page.locator("#selectNote").inner_text()
        check("提示章节数", "2 章" in note, note)

        # 命中栈：按钮必须在最上层且可接收指针
        stack = await page.evaluate("""() => {
          const btn = document.querySelector('#selectMerge');
          const r = btn.getBoundingClientRect();
          const els = document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return { top: els[0] && els[0].id, pe: getComputedStyle(btn).pointerEvents,
                   hidden: document.querySelector('#selectBar').hidden,
                   inViewport: r.bottom <= innerHeight && r.top >= 0 };
        }""")
        check("合并按钮位于命中栈顶层", stack["top"] == "selectMerge", stack)
        check("按钮可接收指针且在视口内",
              stack["pe"] == "auto" and not stack["hidden"] and stack["inViewport"], stack)
        await shot(page, "40-multi-selected.png")

        # 2) 合并对话框
        await fire(page, "#selectMerge")
        check("合并对话框打开", await page.locator("#mergeDialog").is_visible())
        rows = await page.locator("#mergeList .merge-row").count()
        check("对话框列出 2 本", rows == 2, rows)
        lead = await page.locator("#mergeLead").inner_text()
        check("说明含总数", "2 本" in lead and "2 章" in lead, lead)
        checked = await page.locator("#mergeList input:checked").count()
        check("默认选中一本主书", checked == 1, checked)
        await shot(page, "41-merge-dialog.png")

        await fire(page, "#mergeOk")
        await page.wait_for_timeout(1200)
        check("合并后剩 3 本", await page.locator(".card").count() == 3,
              await page.locator(".card").count())
        meta = await page.locator(".card", has_text="孤岛").first.locator(".card-meta").inner_text()
        check("合并体量 5 页 / 2 章", "5 页" in meta and "2 章" in meta, meta)
        check("结果面板按章节列出", await page.locator("#mergeResultList li").count() == 2,
              await page.locator("#mergeResultList li").count())
        await fire(page, "#mergeResultClose")
        check("操作条自动收起", await page.locator("#selectBar").is_hidden())
        check("合并后无残留选中", await selected_count(page) == 0)
        await shot(page, "42-merged.png")

        # 3) 合并结果能读，页数正确
        await card_fire(page, "孤岛")
        await page.wait_for_timeout(1500)
        lbl = await page.locator("#readerPage").inner_text()
        check("合并后共 5 页", "/ 5" in lbl, lbl)
        for _ in range(4):
            await page.keyboard.press("ArrowRight")
            await page.wait_for_timeout(450)
        lbl = await page.locator("#readerPage").inner_text()
        check("能翻到最后一页", "5 / 5" in lbl, lbl)
        img = await page.evaluate("document.querySelector('.comic-pages img')?.naturalWidth || 0")
        check("页面图片已渲染", img > 0, img)
        await shot(page, "43-merged-read.png")
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(700)

        # 4) 类型不一致时拦截
        await card_fire(page, "短歌", ctrl=True)
        await card_fire(page, "夜行", ctrl=True)
        check("混选时合并按钮禁用", not await page.locator("#selectMerge").is_enabled())
        note = await page.locator("#selectNote").inner_text()
        check("提示只能合并同类型", "同类型" in note, note)
        await shot(page, "44-type-mismatch.png")

        # 5) Esc 退出
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(300)
        check("Esc 清空选择", await page.locator("#selectBar").is_hidden()
              and await selected_count(page) == 0)

        # 6) Shift 范围选择（按导入时间排序：短歌 / 夜行 / 孤岛）
        await page.select_option("#sortBy", "added")
        await page.wait_for_timeout(300)
        await card_fire(page, "短歌", ctrl=True)
        await card_fire(page, "孤岛", shift=True)
        check("Shift 选中连续 3 本", await page.locator("#selectCount").inner_text() == "3",
              await page.locator("#selectCount").inner_text())

        # 7) 全选 / 取消全选（先清空，避免已全选时按钮变成「取消全选」）
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(250)
        await fire(page, "#selectAll")
        check("全选 3 本", await page.locator("#selectCount").inner_text() == "3",
              await page.locator("#selectCount").inner_text())
        check("按钮变为取消全选", "取消全选" in await page.locator("#selectAll").inner_text())
        await fire(page, "#selectAll")
        check("再点取消全选", await selected_count(page) == 0)

        # 8) 右键菜单里的「选择」入口
        await card_fire(page, "夜行", event="contextmenu")
        has = await page.locator("#ctxMenu [data-act='select']").count()
        check("右键菜单出现选择项", has == 1, has)
        await fire(page, "#ctxMenu [data-act='select']")
        check("右键可选择单本", await page.locator("#selectCount").inner_text() == "1",
              await page.locator("#selectCount").inner_text())
        check("单本时合并按钮禁用", not await page.locator("#selectMerge").is_enabled())
        await shot(page, "45-ctx-select.png")

        # 9) 多选状态下双击直接打开
        await card_fire(page, "夜行", ctrl=True)
        check("取消选择回到 0", await selected_count(page) == 0)
        await card_fire(page, "夜行", ctrl=True)
        await card_fire(page, "夜行", event="dblclick")
        await page.wait_for_timeout(1200)
        check("双击打开并退出多选",
              await page.evaluate("!document.querySelector('#reader').hidden")
              and await page.locator("#selectBar").is_hidden())
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(700)

        # 10) 键盘 Ctrl+A 全选
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(250)
        await page.evaluate("document.activeElement && document.activeElement.blur && document.activeElement.blur()")
        await page.keyboard.press("Control+a")
        await page.wait_for_timeout(350)
        n = await selected_count(page)
        check("Ctrl+A 全选可见书目", n == 3, n)

        # 11) 切换视图会清空选择
        await page.evaluate("document.querySelector('.nav-item[data-view=\"recent\"]').click()")
        await page.wait_for_timeout(350)
        check("切到最近阅读后操作条隐藏", await page.locator("#selectBar").is_hidden())
        await page.evaluate("document.querySelector('.nav-item[data-view=\"library\"]').click()")
        await page.wait_for_timeout(350)
        check("切回书架后无残留选中", await selected_count(page) == 0)

        # 12) 搜索时保留选中
        await card_fire(page, "夜行", ctrl=True)
        await page.fill("#search", "孤岛")
        await page.wait_for_timeout(350)
        check("筛选后仍记得之前的选择", await page.locator("#selectCount").inner_text() == "1",
              await page.locator("#selectCount").inner_text())
        await page.fill("#search", "")
        await page.wait_for_timeout(300)
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(250)

        # 13) 删除已选书后操作条自动收起
        await card_fire(page, "夜行", ctrl=True)
        await card_fire(page, "夜行", event="contextmenu")
        await fire(page, "#ctxMenu [data-act='delete']")
        await page.wait_for_timeout(300)
        await fire(page, "#confirmOk")
        await page.wait_for_timeout(900)
        check("删掉已选书后操作条收起", await page.locator("#selectBar").is_hidden())
        check("删除后剩 2 本", await page.locator(".card").count() == 2,
              await page.locator(".card").count())

        check("无控制台报错", not errs, errs[:3])
        await b.close()

    print("ALL PASS" if ok else "SOME FAILED")


asyncio.run(main())
