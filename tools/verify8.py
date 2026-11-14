"""平板端适配校验：常见平板尺寸 × 横竖屏

覆盖：
- 平台探测（tablet / 横竖屏 / touch）与安全区注入
- 双栏布局：横屏侧栏展开、书架不横向溢出、详情从右侧滑出
- 阅读器：触屏轻扫翻页、边缘与纵向手势不误触、目录常驻左栏
- 系统返回：面板 → 阅读器 → 对话框 的层级顺序
- 旋转后重排：阅读器不丢书、舞台尺寸跟随
"""
import asyncio
import os
import re

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


async def frame(page, ms=140):
    await page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")
    await page.wait_for_timeout(ms)


async def click_sel(page, sel):
    await page.evaluate(
        "(sel) => { const el = document.querySelector(sel); if (!el) throw new Error('missing ' + sel); el.click(); }",
        sel,
    )
    await frame(page)


async def open_browser(browser, size, touch=True):
    ctx = await browser.new_context(
        viewport={"width": size[0], "height": size[1]},
        has_touch=touch,
        device_scale_factor=1,
    )
    page = await ctx.new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    await page.goto(URL)
    # 等首屏 boot 完成再删库，否则会撞上正在初始化的连接
    await page.wait_for_timeout(700)
    await page.evaluate("() => new Promise((r) => { const q = indexedDB.deleteDatabase('yice-reader'); q.onsuccess = q.onerror = q.onblocked = r; })")
    await page.reload()
    await page.wait_for_timeout(600)
    return ctx, page


async def import_books(page):
    await page.set_input_files("#fileInput", [os.path.join(PARTS, f) for f in FILES])
    await page.wait_for_timeout(2400)


async def metrics(page):
    return await page.evaluate("""() => {
        const app = document.querySelector('.app');
        const grid = getComputedStyle(app).gridTemplateColumns.split(' ')[0];
        const cs = getComputedStyle(document.documentElement);
        const shelf = document.querySelector('#shelf');
        const content = document.querySelector('#content');
        return {
            platform: document.documentElement.dataset.platform,
            orientation: document.documentElement.dataset.orientation,
            input: document.documentElement.dataset.input,
            runtime: document.documentElement.dataset.runtime,
            w: window.innerWidth,
            h: window.innerHeight,
            docW: document.documentElement.scrollWidth,
            appH: Math.round(app.getBoundingClientRect().height),
            sidebar: parseFloat(grid),
            safeTop: cs.getPropertyValue('--safe-top').trim(),
            safeBottom: cs.getPropertyValue('--safe-bottom').trim(),
            cards: shelf ? shelf.children.length : 0,
            shelfRight: shelf ? Math.round(shelf.getBoundingClientRect().right) : 0,
            contentRight: content ? Math.round(content.getBoundingClientRect().right) : 0,
        };
    }""")


async def page_no(page):
    txt = await page.evaluate("document.getElementById('readerPage').textContent")
    m = re.search(r"(\d+)\s*/\s*(\d+)", txt)
    return (int(m.group(1)) if m else -1), txt


async def open_reader(page):
    await page.evaluate("document.querySelectorAll('.card')[0].dispatchEvent(new MouseEvent('click', {bubbles: true}))")
    await page.wait_for_timeout(1500)


async def swipe(page, x, y, dx, dy=0, click_after=False):
    await page.evaluate("""([x, y, dx, dy, clickAfter]) => {
        const st = document.getElementById('readerStage');
        const base = { bubbles: true, cancelable: true, pointerId: 11, pointerType: 'touch', isPrimary: true };
        st.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x, clientY: y, buttons: 1 }));
        st.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x + dx / 2, clientY: y + dy / 2, buttons: 1 }));
        st.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: x + dx, clientY: y + dy, buttons: 0 }));
        if (clickAfter) st.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x + dx, clientY: y + dy }));
    }""", [x, y, dx, dy, click_after])
    await page.wait_for_timeout(520)


async def back(page):
    await page.evaluate("window.dispatchEvent(new Event('native-back'))")
    await page.wait_for_timeout(600)


async def detail_rect(page):
    return await page.evaluate("""() => {
        const d = document.getElementById('detailDialog');
        if (!d.open) return null;
        const r = d.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
                 right: Math.round(r.right), bottom: Math.round(r.bottom) };
    }""")


async def main():
    global errors
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge")

        # ============ 1. 横屏平板 1024×768 ============
        ctx, page = await open_browser(browser, (1024, 768))
        m = await metrics(page)
        check("1024×768 判定为平板", m["platform"] == "tablet", m["platform"])
        check("横屏方向正确", m["orientation"] == "landscape", m["orientation"])
        check("触屏环境识别为 touch", m["input"] == "touch", m["input"])
        check("无横向溢出", m["docW"] <= m["w"] + 1, f"doc {m['docW']} / 视口 {m['w']}")
        check("应用高度铺满视口", abs(m["appH"] - m["h"]) <= 1, f"{m['appH']} vs {m['h']}")
        check("横屏侧栏展开为完整导航", m["sidebar"] >= 190, f"{m['sidebar']}px")
        check("安全区变量已初始化", m["safeTop"].endswith("px") and m["safeBottom"].endswith("px"),
              f"{m['safeTop']}/{m['safeBottom']}")

        await import_books(page)
        m = await metrics(page)
        check("导入 4 本后书架不溢出", m["cards"] == 4 and m["shelfRight"] <= m["contentRight"] + 1,
              f"{m['cards']} 张 / right {m['shelfRight']} vs {m['contentRight']}")
        await shot(page, "v8-land-shelf.png")

        # ---------- 详情：横屏是右侧面板 ----------
        await page.locator(".card").first.click(button="right")  # 右键菜单（三个点按钮已移除）
        await click_sel(page, '[data-act="detail"]')
        await page.wait_for_timeout(400)  # 等滑出动画结束再量
        d = await detail_rect(page)
        check("横屏详情从右侧滑出", d and abs(d["right"] - m["w"]) <= 2 and d["x"] > m["w"] * 0.5, d)
        check("详情面板铺满高度", d and abs(d["bottom"] - m["h"]) <= 2 and d["y"] == 0, d)
        check("详情宽度限制在 440 内", d and d["w"] <= 441, d and d["w"])
        await shot(page, "v8-land-detail.png")
        await back(page)
        check("返回键先关详情", await page.evaluate("!document.getElementById('detailDialog').open"))

        # ---------- 阅读器：横屏漫画默认双页 ----------
        await open_reader(page)
        await frame(page, 300)
        page1, label = await page_no(page)
        mode = await page.evaluate("document.querySelector('.comic-pages')?.dataset.mode")
        check("横屏首次打开用双页对开", mode == "double", f"{mode} / {label}")
        check("阅读器已打开且页码可读", page1 == 1, label)

        # ---------- 触屏轻扫 ----------
        await swipe(page, 500, 400, -150)
        page2, label2 = await page_no(page)
        check("左滑翻到下一页", page2 > page1, f"{label} -> {label2}")
        await swipe(page, 500, 400, 150)
        page3, label3 = await page_no(page)
        check("右滑退回上一页", page3 < page2, f"{label2} -> {label3}")

        await swipe(page, 500, 400, -150, click_after=True)
        page4, _ = await page_no(page)
        check("手势后补发的 click 不重复翻页", page4 == page3 + (2 if mode == "double" else 1), f"{page3} -> {page4}")

        # ---------- 点屏幕切换工具条（真机踩过的坑） ----------
        # 安卓 WebView 里点一下会先补发一个合成 mousemove，再派发 click。
        # 旧实现 onMove 先 wake() 把 idle 摘掉，紧接着的 click 就以为「本来没收起」，
        # 又调 toggleChrome 把工具条藏回去 —— 平板上一按只闪一下，唤不出来。
        await page.wait_for_timeout(3600)
        check("静置 3.2s 后工具条自动收起",
              await page.evaluate("document.getElementById('reader').classList.contains('idle')"))
        await page.evaluate("""() => {
            const mv = new MouseEvent('mousemove', { bubbles: true, clientX: 400, clientY: 400 });
            Object.defineProperty(mv, 'sourceCapabilities', { value: { firesTouchEvents: true } });
            document.dispatchEvent(mv);
            document.getElementById('readerStage')
                .dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 400, clientY: 400 }));
        }""")
        await frame(page, 320)
        check("触摸点一下能唤出工具条",
              await page.evaluate("!document.getElementById('reader').classList.contains('idle')"))
        check("工具条 opacity 为 1",
              await page.evaluate("getComputedStyle(document.querySelector('.reader-top')).opacity") == "1")
        await page.evaluate("""() => document.getElementById('readerStage')
            .dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 400, clientY: 400 }))""")
        await frame(page, 320)
        check("再点一下工具条收起",
              await page.evaluate("document.getElementById('reader').classList.contains('idle')"))
        await page.evaluate("""() => document.getElementById('readerStage')
            .dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 400, clientY: 400 }))""")
        await frame(page, 320)

        # 边缘起手交给系统
        before, _ = await page_no(page)
        await swipe(page, 8, 400, -150)
        after, _ = await page_no(page)
        check("左侧 24px 内起手不翻页", before == after, f"{before} -> {after}")

        # 纵向滑动当滚动
        before, _ = await page_no(page)
        await swipe(page, 500, 380, -30, 160)
        after, _ = await page_no(page)
        check("纵向滑动不翻页", before == after, f"{before} -> {after}")

        # ---------- 目录：横屏常驻左栏 ----------
        await click_sel(page, '[data-r="toc"]')
        await page.wait_for_timeout(500)
        rail = await page.evaluate("""() => {
            const rd = document.getElementById('reader');
            const panel = document.getElementById('readerPanel').getBoundingClientRect();
            const stage = document.getElementById('readerStage').getBoundingClientRect();
            const top = document.getElementById('readerTop').getBoundingClientRect();
            return { open: rd.classList.contains('rail-open'), px: Math.round(panel.x), py: Math.round(panel.y),
                     pw: Math.round(panel.width), sx: Math.round(stage.x), sw: Math.round(stage.width),
                     tx: Math.round(top.x) };
        }""")
        check("横屏目录变成常驻左栏", rail["open"] and rail["px"] == 0, rail)
        check("目录宽度固定 344", abs(rail["pw"] - 344) <= 1, rail["pw"])
        check("正文让出左栏位置", abs(rail["sx"] - 344) <= 1 and abs(rail["sw"] - 680) <= 2, rail)
        check("顶部工具条同步右移", abs(rail["tx"] - 344) <= 1, rail["tx"])
        await shot(page, "v8-land-reader-toc.png")

        await click_sel(page, '[data-r="toc"]')
        await page.wait_for_timeout(500)
        rail2 = await page.evaluate("""() => ({
            open: document.getElementById('reader').classList.contains('rail-open'),
            sx: Math.round(document.getElementById('readerStage').getBoundingClientRect().x),
        })""")
        check("关闭目录后正文回到全宽", not rail2["open"] and rail2["sx"] == 0, rail2)

        # ---------- 返回层级：面板 → 阅读器 ----------
        await click_sel(page, '[data-r="settings"]')
        await page.wait_for_timeout(400)
        await back(page)
        check("返回键先关阅读设置面板", await page.evaluate("!document.getElementById('readerPanel').classList.contains('open')")
              and await page.evaluate("!document.getElementById('reader').hidden"))
        await back(page)
        check("再按返回才退出阅读器", await page.evaluate("document.getElementById('reader').hidden"))

        # ---------- 原生 inset 注入（模拟 Android 刘海/手势条） ----------
        await page.evaluate("window.__setNativeInsets({ top: 24, right: 0, bottom: 18, left: 6 })")
        await page.wait_for_timeout(300)
        inset = await page.evaluate("""() => {
            const cs = getComputedStyle(document.documentElement);
            const app = getComputedStyle(document.querySelector('.app'));
            return { top: cs.getPropertyValue('--safe-top').trim(), left: cs.getPropertyValue('--safe-left').trim(),
                     pad: app.paddingTop + ' / ' + app.paddingLeft };
        }""")
        check("原生 inset 写入安全区变量", inset["top"] == "24px" and inset["left"] == "6px", inset)
        check("应用区域按安全区留白", inset["pad"].startswith("24px") and inset["pad"].endswith("6px"), inset["pad"])
        await page.evaluate("window.__setNativeInsets({ top: 0, right: 0, bottom: 0, left: 0 })")

        # ---------- 设置页环境信息 ----------
        await click_sel(page, '.nav-item[data-view="settings"]')
        await frame(page, 200)
        info = await page.evaluate("document.getElementById('devInfo').textContent")
        check("设置页显示当前环境", "1024×768" in info and "横屏" in info, info)
        check("设置页有三个平板开关", await page.locator("[data-dev]").count() == 6,
              await page.locator("[data-dev]").count())
        await shot(page, "v8-settings.png")

        check("横屏流程无控制台报错", not errors, errors[:3])
        await ctx.close()

        # ============ 2. 竖屏平板 768×1024 ============
        errors = []
        ctx, page = await open_browser(browser, (768, 1024))
        m = await metrics(page)
        check("768×1024 判定为平板竖屏", m["platform"] == "tablet" and m["orientation"] == "portrait", m)
        check("竖屏侧栏收成图标条", m["sidebar"] <= 90, f"{m['sidebar']}px")
        check("竖屏无横向溢出", m["docW"] <= m["w"] + 1, f"doc {m['docW']} / 视口 {m['w']}")

        await import_books(page)
        await shot(page, "v8-port-shelf.png")
        await page.locator(".card").first.click(button="right")  # 右键菜单（三个点按钮已移除）
        await click_sel(page, '[data-act="detail"]')
        d = await detail_rect(page)
        check("竖屏详情是居中弹窗", d and 0 < d["x"] < m["w"] * 0.2 and d["right"] < m["w"], d)
        check("竖屏弹窗不超出屏幕", d and d["bottom"] <= m["h"] and d["w"] <= m["w"], d)
        await shot(page, "v8-port-detail.png")
        await back(page)

        await open_reader(page)
        await frame(page, 300)
        _, label = await page_no(page)
        mode = await page.evaluate("document.querySelector('.comic-pages')?.dataset.mode")
        check("竖屏漫画用单页", mode == "single", f"{mode} / {label}")

        await click_sel(page, '[data-r="toc"]')
        await page.wait_for_timeout(450)
        pr = await page.evaluate("""() => {
            const rd = document.getElementById('reader');
            const panel = document.getElementById('readerPanel').getBoundingClientRect();
            const stage = document.getElementById('readerStage').getBoundingClientRect();
            return { open: rd.classList.contains('rail-open'), right: Math.round(panel.right),
                     pw: Math.round(panel.width), sx: Math.round(stage.x) };
        }""")
        check("竖屏目录是覆盖式侧栏", not pr["open"] and pr["sx"] == 0, pr)
        check("竖屏侧栏贴右边缘", pr["right"] == m["w"], pr)
        await shot(page, "v8-port-reader-toc.png")
        await back(page)
        await back(page)

        check("竖屏流程无控制台报错", not errors, errors[:3])
        await ctx.close()

        # ============ 3. iPad 尺寸 1194×834 / 834×1194 ============
        errors = []
        ctx, page = await open_browser(browser, (1194, 834))
        m = await metrics(page)
        check("1194×834 识别为横屏平板", m["platform"] == "tablet" and m["orientation"] == "landscape", m)
        await import_books(page)
        await open_reader(page)
        await frame(page, 300)
        await click_sel(page, '[data-r="toc"]')
        await page.wait_for_timeout(450)
        sw = await page.evaluate("Math.round(document.getElementById('readerStage').getBoundingClientRect().width)")
        check("1194 宽下正文让位后仍够宽", sw >= 700, f"{sw}px")
        await shot(page, "v8-ipad-land-reader.png")
        await ctx.close()

        errors = []
        ctx, page = await open_browser(browser, (834, 1194))
        m = await metrics(page)
        check("834×1194 识别为竖屏平板", m["platform"] == "tablet" and m["orientation"] == "portrait", m)
        check("834 竖屏无横向溢出", m["docW"] <= m["w"] + 1, f"doc {m['docW']} / 视口 {m['w']}")
        await import_books(page)
        await open_reader(page)
        await frame(page, 400)
        _, label = await page_no(page)
        width_var = await page.evaluate("document.querySelector('.epub-wrap') ? getComputedStyle(document.querySelector('.epub-wrap')).paddingLeft : 'comic'")
        check("834×1194 阅读器可用", label != "", label)
        await shot(page, "v8-ipad-port-reader.png")
        await ctx.close()

        # ============ 4. 旋转：竖 → 横，阅读器不丢书 ============
        errors = []
        ctx, page = await open_browser(browser, (768, 1024))
        await import_books(page)
        await open_reader(page)
        await frame(page, 300)
        before, _ = await page_no(page)
        await page.set_viewport_size({"width": 1024, "height": 768})
        await page.wait_for_timeout(700)
        m2 = await metrics(page)
        after_stage = await page.evaluate("Math.round(document.getElementById('readerStage').getBoundingClientRect().width)")
        after, after_label = await page_no(page)
        check("旋转后仍判定为横屏", m2["orientation"] == "landscape", m2["orientation"])
        check("旋转后侧栏重新展开", m2["sidebar"] >= 190, m2["sidebar"])
        check("旋转后阅读器还在且已重排", after_stage == 1024, f"{after_stage}px")
        check("旋转后页码不丢", after >= 1 and after_label != "", f"{before} -> {after}")
        await shot(page, "v8-rotate-land.png")

        await page.set_viewport_size({"width": 768, "height": 1024})
        await page.wait_for_timeout(700)
        m3 = await metrics(page)
        back_stage = await page.evaluate("Math.round(document.getElementById('readerStage').getBoundingClientRect().width)")
        check("转回竖屏后方向还原", m3["orientation"] == "portrait", m3["orientation"])
        check("转回竖屏正文回到全宽", back_stage == 768, f"{back_stage}px")
        check("旋转过程无报错", not errors, errors[:3])
        await ctx.close()

        # ============ 5. 小屏横屏 / 桌面：不误判、不破坏原布局 ============
        errors = []
        ctx, page = await open_browser(browser, (960, 600))
        m = await metrics(page)
        check("960×600 仍是平板布局", m["platform"] == "tablet", m["platform"])
        check("矮横屏无横向溢出", m["docW"] <= m["w"] + 1, f"doc {m['docW']} / 视口 {m['w']}")
        await ctx.close()

        errors = []
        ctx, page = await open_browser(browser, (1280, 900), touch=False)
        m = await metrics(page)
        check("桌面环境识别为 pointer", m["input"] == "pointer", m["input"])
        check("桌面仍是三栏宽度（侧栏 208）", m["sidebar"] >= 190, m["sidebar"])
        await ctx.close()

        await browser.close()

    print("\n" + ("ALL PASS" if ok else "HAS FAILURE"))
    if errors:
        print("errors:", errors[:5])


asyncio.run(main())
