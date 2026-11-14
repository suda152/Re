"""verify15 — 轻触 vs 滑动手势区分 + 工具条只在中心点按呼出

用例：
 1. 工具条隐藏时：点两侧只翻页，工具条保持隐藏
 2. 工具条隐藏时：点中心唤出工具条；再点中心收起
 3. 起手到落点位移大的「手势」（水平/垂直）不触发翻页、不触发工具条
 4. 条漫模式：两侧轻点无动作，中心轻点切换工具条；垂直滚动手势不弹工具条
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
        await page.wait_for_timeout(1600)

        async def idle_state():
            return await page.evaluate("document.getElementById('reader').classList.contains('idle')")

        async def tap(x, y):
            """合成一次触摸轻触：pointerdown → click，位移 0"""
            await page.evaluate("""([x, y]) => {
              const st = document.getElementById('readerStage');
              st.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7,
                pointerType: 'touch', clientX: x, clientY: y }));
              st.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
            }""", [x, y])
            await page.wait_for_timeout(450)

        async def gesture(x0, y0, x1, y1):
            """合成一次手势：起手到落点位移大，最后补发 click（模拟 WebView 行为）"""
            await page.evaluate("""([x0, y0, x1, y1]) => {
              const st = document.getElementById('readerStage');
              st.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7,
                pointerType: 'touch', clientX: x0, clientY: y0 }));
              st.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7,
                pointerType: 'touch', clientX: x1, clientY: y1 }));
              st.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x1, clientY: y1 }));
            }""", [x0, y0, x1, y1])
            await page.wait_for_timeout(450)

        async def page_num():
            return page_no(await page.locator("#readerPage").inner_text())

        # 等工具条自动收起（初始打开时是显示的，3.2s 后 idle）
        await page.wait_for_timeout(3600)
        check("静置后工具条收起", await idle_state())

        # ---- 用例 1：隐藏时两侧翻页，工具条保持隐藏 ----
        n0 = await page_num()
        await tap(1440 * 0.9, 450)   # 右侧 → 下一页
        n1 = await page_num()
        check("隐藏时右侧轻点翻页", n1 == n0 + 1, f"{n0}->{n1}")
        check("右侧轻点不唤出工具条", await idle_state())
        await tap(1440 * 0.1, 450)   # 左侧 → 上一页
        n2 = await page_num()
        check("隐藏时左侧轻点翻回", n2 == n0, f"{n1}->{n2}")
        check("左侧轻点不唤出工具条", await idle_state())

        # ---- 用例 2：中心轻点开/关工具条 ----
        await tap(720, 450)
        check("中心轻点唤出工具条", not await idle_state())
        await tap(720, 450)
        check("再点中心收起工具条", await idle_state())

        # ---- 用例 3：手势（位移大）不翻页、不动工具条 ----
        n3 = await page_num()
        await gesture(500, 400, 620, 400)   # 水平位移 120px + 补发 click
        check("水平手势不算点按（不翻页）", await page_num() == n3)
        check("水平手势不唤出工具条", await idle_state())
        await gesture(720, 300, 720, 480)   # 垂直位移 180px（模拟滚动）
        check("垂直手势不算点按", await page_num() == n3 and await idle_state())

        # ---- 用例 4：条漫模式 ----
        await tap(720, 450)  # 先唤出工具条，否则设置按钮在视口外
        await page.click('[data-r="settings"]')
        await page.wait_for_timeout(400)
        await page.click('[data-set="mode"][data-val="scroll"]')
        await page.wait_for_timeout(500)
        await page.click('[data-r="settings"]')
        await page.wait_for_timeout(400)

        # 条漫模式重建引擎后标签格式变化，重新取基线
        n_scroll = await page_num()
        hidden0 = await idle_state()
        await tap(1440 * 0.9, 450)   # 条漫右侧轻点 → 无动作
        check("条漫右侧轻点无动作", await page_num() == n_scroll, f"{n_scroll} -> {await page_num()}")
        check("条漫右侧轻点不动工具条", await idle_state() == hidden0)
        await tap(720, 450)
        check("条漫中心轻点切换工具条", await idle_state() != hidden0)
        await tap(720, 450)
        check("条漫中心再点恢复", await idle_state() == hidden0)
        await gesture(720, 300, 720, 500)
        check("条漫垂直滚动手势不弹工具条", await idle_state() == hidden0)

        await page.keyboard.press("Escape")
        await page.wait_for_timeout(500)
        await browser.close()

    print(f"\n{len(passed)} passed, {len(failed)} failed")
    if failed:
        print("FAILED:", failed)
        sys.exit(1)


asyncio.run(main())
