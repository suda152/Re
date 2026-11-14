import asyncio, os, json, re
from playwright.async_api import async_playwright

ROOT = r"D:\agentwork\wb\spaces\2026_11_13_19-50-55\tome-app"
SHOTS = r"D:\agentwork\wb\spaces\2026_11_13_19-50-55\verify-shots"
os.makedirs(SHOTS, exist_ok=True)
URL = "http://127.0.0.1:5178/"

ERRORS = []
CHECKS = []


def check(name, ok, detail=""):
    CHECKS.append({"name": name, "ok": bool(ok), "detail": str(detail)})
    print(("PASS " if ok else "FAIL ") + name + (f"  -> {detail}" if detail else ""))


async def shot(page, name):
    await page.screenshot(path=os.path.join(SHOTS, name))


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", headless=True)
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()
        page.on("console", lambda m: ERRORS.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: ERRORS.append(f"[pageerror] {e}"))

        await page.goto(URL, wait_until="networkidle")
        await page.wait_for_timeout(500)
        check("空书架提示可见", await page.locator("#emptyState").is_visible())
        await shot(page, "01-empty.png")

        files = [os.path.join(ROOT, "samples", n) for n in ("星轨列车.epub", "夜航.cbz", "长夜手记.txt")]
        await page.set_input_files("#fileInput", files)
        await page.wait_for_selector(".card", timeout=20000)
        await page.wait_for_timeout(2200)
        check("导入三本书", await page.locator(".card").count() == 3, await page.locator(".card").count())
        sub = await page.locator("#viewSub").inner_text()
        check("副标题更新为藏书数", "3 本" in sub, sub)
        await shot(page, "02-shelf.png")

        # --- EPUB ---
        await page.locator(".card", has_text="星轨列车").first.click()
        await page.wait_for_timeout(1500)
        check("阅读器打开", await page.locator("#reader").is_visible())
        check("EPUB 首章有内容", await page.evaluate("document.querySelector('.epub-flow')?.innerText.length") > 300)
        lbl = await page.locator("#readerPage").inner_text()
        check("首章页码正常", "第一章" in lbl, lbl)
        await shot(page, "03-reader-epub.png")

        await page.keyboard.press("ArrowRight")
        await page.wait_for_timeout(1200)
        lbl2 = await page.locator("#readerPage").inner_text()
        check("翻页进入第二章", "第二章" in lbl2, lbl2)
        await shot(page, "04-reader-ch2.png")

        # 字号放大后应当分页更多
        await page.click("[data-r='settings']")
        await page.wait_for_timeout(500)
        for _ in range(5):
            await page.click("[data-set='fontSize'][data-val='1']")
            await page.wait_for_timeout(180)
        await shot(page, "05-settings-large-font.png")
        info = await page.evaluate("""() => {
          const f = document.querySelector('.epub-flow');
          const s = getComputedStyle(f);
          return {fs: s.fontSize, sw: f.scrollWidth, cw: f.clientWidth, label: document.querySelector('#readerPage').textContent};
        }""")
        check("字号设置生效", info["fs"].startswith("24"), info["fs"])
        check("内容超出单页时可分页", info["sw"] > info["cw"], f"{info['sw']}>{info['cw']} {info['label']}")

        # 连续翻页 3 次，页码 / 章节应递进
        await page.click("[data-r='panel-close']")
        seen = []
        for _ in range(3):
            await page.keyboard.press("ArrowRight")
            await page.wait_for_timeout(700)
            seen.append(await page.locator("#readerPage").inner_text())
        check("连续翻页页码递进", len(set(seen)) >= 2, seen)
        await shot(page, "06-reader-paged.png")

        # 主题
        await page.click("[data-r='settings']")
        await page.wait_for_timeout(400)
        await page.click(".swatch[data-t='sepia']")
        await page.wait_for_timeout(600)
        check("主题切换为米黄", await page.locator("#reader").get_attribute("data-rt-theme") == "sepia")
        await shot(page, "07-sepia.png")
        await page.click(".swatch[data-t='dark']")
        await page.wait_for_timeout(600)
        await shot(page, "08-dark.png")
        await page.click(".swatch[data-t='light']")
        await page.wait_for_timeout(400)
        await page.click("[data-r='panel-close']")
        await page.wait_for_timeout(300)

        # 目录
        await page.click("[data-r='toc']")
        await page.wait_for_timeout(600)
        check("目录条目数", await page.locator(".toc-item").count() == 3, await page.locator(".toc-item").count())
        check("目录高亮当前章", await page.locator(".toc-item.active").count() == 1)
        await shot(page, "09-toc.png")
        await page.locator(".toc-item").nth(2).click()
        await page.wait_for_timeout(1200)
        check("目录跳转到第三章", "第三章" in await page.locator("#readerPage").inner_text())

        # 关闭并检查进度回写
        pct_reader = await page.locator("#readerPct").inner_text()
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(900)
        check("阅读器已关闭", await page.locator("#reader").is_hidden())
        card_pct = await page.locator(".card", has_text="星轨列车").first.locator(".card-meta").inner_text()
        check("书卡显示进度", pct_reader.replace("%", "") in card_pct, f"{pct_reader} / {card_pct}")
        await shot(page, "10-shelf-with-progress.png")

        # 重新打开应回到第三章
        await page.locator(".card", has_text="星轨列车").first.click()
        await page.wait_for_timeout(1500)
        check("重开回到上次章节", "第三章" in await page.locator("#readerPage").inner_text(),
              await page.locator("#readerPage").inner_text())
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(700)

        # --- 漫画 ---
        await page.locator(".card", has_text="夜航").first.click()
        await page.wait_for_timeout(2000)
        check("漫画打开在第一页", "1 / 12" in await page.locator("#readerPage").inner_text(),
              await page.locator("#readerPage").inner_text())
        box = await page.evaluate("""() => {
          const img = document.querySelector('.comic-pages img');
          const bar = document.querySelector('.reader-bottom');
          if (!img) return null;
          const r = img.getBoundingClientRect(), b = bar.getBoundingClientRect();
          return {imgBottom: Math.round(r.bottom), barTop: Math.round(b.top), imgTop: Math.round(r.top), h: Math.round(r.height)};
        }""")
        check("漫画不遮挡底部工具条", box and box["imgBottom"] <= box["barTop"] + 1, box)
        await shot(page, "11-comic-single.png")

        # 横屏首次打开默认双页（步进 2），竖屏单页（步进 1）——按当前模式算期望
        before = await page.locator("#readerPage").inner_text()
        await page.keyboard.press("ArrowRight")
        await page.wait_for_timeout(900)
        after = await page.locator("#readerPage").inner_text()

        def page_no(t):
            m = re.search(r"(\d+)\s*/\s*12", t)
            return int(m.group(1)) if m else 0

        step = 2 if "双页" in before else 1
        check("漫画翻页", page_no(after) == page_no(before) + step, f"{before} -> {after}（步进 {step}）")

        await page.click("[data-r='settings']")
        await page.wait_for_timeout(400)
        await page.click("[data-set='mode'][data-val='double']")
        await page.wait_for_timeout(1200)
        check("双页模式渲染两页", await page.locator(".comic-pages img").count() == 2)
        await page.click("[data-r='panel-close']")
        await page.wait_for_timeout(300)
        await shot(page, "12-comic-double.png")

        await page.click("[data-r='settings']")
        await page.wait_for_timeout(300)
        await page.click("[data-set='mode'][data-val='scroll']")
        await page.wait_for_timeout(1600)
        await page.click("[data-r='panel-close']")
        await page.wait_for_timeout(300)
        sc = await page.evaluate("""() => {
          const s = document.querySelector('.comic-scroll');
          const img = s && s.querySelector('img');
          return {top: s && Math.round(s.scrollTop), max: s && Math.round(s.scrollHeight - s.clientHeight), ratio: s ? (s.scrollTop/(s.scrollHeight-s.clientHeight)) : 0, ar: img && getComputedStyle(img).aspectRatio};
        }""")
        check("条漫保留阅读位置", sc and sc["top"] > 10, sc)
        await shot(page, "13-comic-scroll.png")
        await page.mouse.move(600, 400)
        await page.mouse.wheel(0, 1400)
        await page.wait_for_timeout(900)
        check("条漫滚动进度更新", await page.locator("#readerPct").inner_text() != "0%",
              await page.locator("#readerPct").inner_text())
        await shot(page, "14-comic-scrolled.png")
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(800)

        # --- 尺寸适配 ---
        for w, h, name in ((1024, 768, "15-tablet-landscape.png"), (834, 1112, "16-tablet-portrait.png"), (1280, 800, "17-desktop-1280.png")):
            await page.set_viewport_size({"width": w, "height": h})
            await page.wait_for_timeout(600)
            ov = await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            check(f"{w}x{h} 无横向溢出", ov <= 1, ov)
            await shot(page, name)

        # 平板竖屏下的阅读器
        await page.locator(".card", has_text="星轨列车").first.click()
        await page.wait_for_timeout(1400)
        await page.click("[data-r='settings']")
        await page.wait_for_timeout(500)
        await shot(page, "18-portrait-reader.png")
        await page.click("[data-r='panel-close']")
        await page.set_viewport_size({"width": 1440, "height": 900})
        await page.wait_for_timeout(600)
        await shot(page, "19-portrait-reader-wide.png")
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(700)

        await page.click(".nav-item[data-view='stats']")
        await page.wait_for_timeout(600)
        await shot(page, "20-stats.png")
        await page.click(".nav-item[data-view='settings']")
        await page.wait_for_timeout(600)
        await shot(page, "21-settings-view.png")
        await page.click(".nav-item[data-view='recent']")
        await page.wait_for_timeout(600)
        await shot(page, "22-recent.png")

        # 重复导入
        await page.set_input_files("#fileInput", [files[2]])
        await page.wait_for_timeout(2000)
        check("重复导入被拦截", await page.locator(".card").count() == 3,
              await page.locator("#importList li").first.inner_text())

        # 右键菜单 + 删除
        await page.click(".nav-item[data-view='library']")
        await page.wait_for_timeout(500)
        await page.locator(".card", has_text="长夜手记").first.click(button="right")
        await page.wait_for_timeout(400)
        check("右键菜单出现", await page.locator("#ctxMenu").is_visible())
        await shot(page, "23-context-menu.png")
        await page.click("#ctxMenu [data-act='delete']")
        await page.wait_for_timeout(400)
        await page.click("#confirmOk")
        await page.wait_for_timeout(900)
        check("删除后书卡减少", await page.locator(".card").count() == 2, await page.locator(".card").count())

        # 清空全部
        await page.click("[data-action='clear-all']")
        await page.wait_for_timeout(400)
        await page.click("#confirmOk")
        await page.wait_for_timeout(1200)
        check("清空后回到空书架", await page.locator(".card").count() == 0 and await page.locator("#emptyState").is_visible())
        await shot(page, "24-cleared.png")

        check("无控制台报错", not ERRORS, ERRORS[:3])

        await browser.close()

    fails = [c for c in CHECKS if not c["ok"]]
    print(f"\n{len(CHECKS) - len(fails)}/{len(CHECKS)} checks passed")
    if ERRORS:
        print("ERRORS:")
        for e in ERRORS[:10]:
            print(" ", e)


asyncio.run(main())
