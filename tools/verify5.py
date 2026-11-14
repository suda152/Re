"""多分段（同书多卷）导入与合并的端到端校验。"""
import asyncio
import os
from playwright.async_api import async_playwright

ROOT = r"D:\agentwork\wb\spaces\2026_11_13_19-50-55\tome-app"
PARTS = os.path.join(ROOT, "samples", "parts")
SHOTS = r"D:\agentwork\wb\spaces\2026_11_13_19-50-55\verify-shots"
URL = "http://127.0.0.1:5178/"

ok = True


def check(name, cond, detail=""):
    global ok
    ok = ok and bool(cond)
    print(("PASS " if cond else "FAIL ") + name + (f" -> {detail}" if detail else ""))


async def file_count(page):
    return await page.evaluate("""() => new Promise((res, rej) => {
      const req = indexedDB.open('yice-reader');
      req.onsuccess = () => {
        const db = req.result;
        const c = db.transaction('files', 'readonly').objectStore('files').count();
        c.onsuccess = () => res(c.result);
        c.onerror = () => rej(c.error);
      };
      req.onerror = () => rej(req.error);
    })""")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="msedge", headless=True)
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.goto(URL, wait_until="networkidle")

        # 1) 一次导入 6 个分卷文件
        batch1 = ["夜航 01.cbz", "夜航 02.cbz", "星轨列车 第一册.epub",
                  "星轨列车 第二册.epub", "长夜手记 上.txt", "长夜手记 下.txt"]
        await page.set_input_files("#fileInput", [os.path.join(PARTS, f) for f in batch1])
        await page.wait_for_timeout(4500)

        cards = await page.locator(".card").count()
        check("6 个文件归为 3 本书", cards == 3, cards)

        titles = await page.locator(".card-title").all_inner_texts()
        check("书名去掉卷号", sorted(titles) == sorted(["夜航", "星轨列车", "长夜手记"]), titles)

        metas = await page.locator(".card-meta").all_inner_texts()
        check("卡片按章 / 册标出分段", all(("2 册" in m or "2 章" in m) and "个文件" not in m for m in metas), metas)
        await page.screenshot(path=os.path.join(SHOTS, "30-merged-shelf.png"))

        # 2) 漫画：4 + 3 = 7 页，可翻到第二卷末尾
        await page.locator(".card", has_text="夜航").first.click()
        await page.wait_for_timeout(1600)
        lbl = await page.locator("#readerPage").inner_text()
        check("夜航共 7 页", "/ 7" in lbl, lbl)
        await page.evaluate("""() => {
          const s = document.querySelector('#readerSlider');
          s.value = 1000;
          s.dispatchEvent(new Event('input'));
          s.dispatchEvent(new Event('change'));
        }""")
        await page.wait_for_timeout(900)
        lbl = await page.locator("#readerPage").inner_text()
        check("可跳到第二卷末页", "7 / 7" in lbl, lbl)
        await page.screenshot(path=os.path.join(SHOTS, "31-merged-comic-last.png"))
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(800)

        # 3) 小说：目录跨册，章节序号连续
        await page.locator(".card", has_text="星轨列车").first.click()
        await page.wait_for_timeout(1800)
        meta = await page.locator("#readerMeta").inner_text()
        check("阅读器标出分段数", "2 册" in meta, meta)
        await page.click("[data-r='toc']")
        await page.wait_for_timeout(500)
        toc = await page.locator(".toc-item .txt").all_inner_texts()
        check("目录共 4 条且带册号",
              len(toc) == 4 and "第 1 册" in toc[0] and "第 2 册" in toc[3], toc)
        await page.screenshot(path=os.path.join(SHOTS, "32-merged-toc.png"))
        await page.locator(".toc-item").nth(2).click()
        await page.wait_for_timeout(1400)
        text = await page.evaluate("document.querySelector('.epub-flow').innerText")
        check("跨册跳转读到第二册正文", "终点" in text, text[:60].replace("\n", " "))
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(800)

        # 4) 第二批导入同一系列，仍并入原书
        await page.set_input_files("#fileInput", [os.path.join(PARTS, "夜航 03.cbz")])
        await page.wait_for_timeout(3500)
        check("第二批未新建书目", await page.locator(".card").count() == 3,
              await page.locator(".card").count())
        meta = await page.locator(".card", has_text="夜航").locator(".card-meta").inner_text()
        check("页数累加到 9 页 / 3 章", "9 页" in meta and "3 章" in meta, meta)

        # 5) 无关书籍不误合并
        await page.set_input_files("#fileInput", [os.path.join(PARTS, "孤岛.cbz")])
        await page.wait_for_timeout(3000)
        check("无关书籍单独成书", await page.locator(".card").count() == 4,
              await page.locator(".card").count())

        # 5b) 文件名只剩「第 N 章」时，用 EPUB 元数据标题归并
        await page.set_input_files("#fileInput", [
            os.path.join(PARTS, "第一章.epub"), os.path.join(PARTS, "第二章.epub")])
        await page.wait_for_timeout(3500)
        check("按元数据标题归为一本", await page.locator(".card").count() == 5,
              await page.locator(".card").count())
        meta = await page.locator(".card", has_text="孤星纪事").locator(".card-meta").inner_text()
        check("续章合成 2 册 / 2 章", "2 册" in meta and "2 章" in meta, meta)

        # 6) 手动合并
        await page.locator(".card", has_text="孤岛").first.click(button="right")
        await page.wait_for_timeout(400)
        await page.click("#ctxMenu [data-act='merge']")
        await page.wait_for_timeout(400)
        cands = await page.locator("#ctxMenu [data-target]").all_inner_texts()
        check("候选只列出同类型的书", len(cands) == 1 and "夜航" in cands[0], cands)
        await page.screenshot(path=os.path.join(SHOTS, "33-merge-picker.png"))
        await page.locator("#ctxMenu [data-target]").filter(has_text="夜航").first.click()
        await page.wait_for_timeout(500)
        await page.click("#confirmOk")
        await page.wait_for_timeout(1600)
        check("手动合并后少一本书", await page.locator(".card").count() == 4,
              await page.locator(".card").count())
        meta = await page.locator(".card", has_text="夜航").locator(".card-meta").inner_text()
        check("合并后 12 页 / 4 章", "12 页" in meta and "4 章" in meta, meta)
        check("合并结果按章节列出",
              await page.locator("#mergeResultList li").count() == 4,
              await page.locator("#mergeResultList li").count())
        await page.click("#mergeResultClose")
        await page.wait_for_timeout(400)

        # 7) 删除时所有分段文件一并清理
        before = await file_count(page)
        await page.locator(".card", has_text="夜航").first.click(button="right")
        await page.wait_for_timeout(300)
        await page.click("#ctxMenu [data-act='delete']")
        await page.wait_for_timeout(300)
        await page.click("#confirmOk")
        await page.wait_for_timeout(1500)
        after = await file_count(page)
        check("删除后分段文件全清理", after == before - 4, f"{before} -> {after}")

        check("无控制台报错", not errs, errs[:3])
        print("ALL PASS" if ok else "HAS FAILURE")
        await b.close()


asyncio.run(main())
