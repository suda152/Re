"""批量删除 + 大章节书打开的校验

背景：一本书由几百个 CBZ 组成时，旧实现打开会把所有分段一次性读进内存、
逐个 JSZip 解压，300 章直接卡死打不开。这里守住两件事：

1. 打开只读取当前章那一个文件，跳章时才读下一个，远处章自动释放
2. 批量删除能一次删多本，文件记录跟着减少，误删不了没选中的书
"""
import asyncio
import os
import time

from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(os.path.dirname(ROOT.rstrip("\\/")), "verify-shots")
URL = "http://127.0.0.1:5178/"

ok = True
errors = []

CHAPTERS = 300
PAGES = 10


def check(name, cond, detail=""):
    global ok
    print(("PASS " if cond else "FAIL ") + name + (f" -> {detail}" if detail else ""))
    ok = ok and bool(cond)


MAKE_BOOK = """
async ({ chapters, pages, title }) => {
  const { db } = await import('/js/db.js');
  const { makeBook } = await import('/js/parts.js');

  const canvas = document.createElement('canvas');
  canvas.width = 200; canvas.height = 300;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3a4a5a'; ctx.fillRect(0, 0, 200, 300);
  ctx.fillStyle = '#c8d4e0'; ctx.font = 'bold 40px sans-serif';
  const imgBlob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const imgBuf = await imgBlob.arrayBuffer();

  const parts = [];
  for (let c = 1; c <= chapters; c++) {
    const zip = new JSZip();
    for (let p = 1; p <= pages; p++) zip.file(`p${String(p).padStart(3, '0')}.png`, imgBuf);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const id = 'probe-' + title + '-' + String(c).padStart(4, '0');
    const name = `${title} 第${String(c).padStart(3, '0')}话.cbz`;
    await db.putFile(id, new File([blob], name, { type: 'application/zip' }));
    parts.push({
      id, name, size: blob.size, ext: 'cbz', type: 'comic',
      count: pages, countLabel: `${pages} 页`, order: [c],
    });
  }
  const book = makeBook(parts, { title, type: 'comic' });
  await db.putBook(book);
  return { id: book.id, total: book.count, chapters: parts.length, size: book.size };
}
"""

COUNT_FILES = """
async () => {
  const { db } = await import('/js/db.js');
  const { bookParts } = await import('/js/parts.js');
  const books = await db.allBooks();
  return books.reduce((n, b) => n + bookParts(b).length, 0);
}
"""


async def frame(page, ms=150):
    await page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")
    await page.wait_for_timeout(ms)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge")
        ctx = await browser.new_context(viewport={"width": 1180, "height": 820}, has_touch=False)
        page = await ctx.new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        await page.goto(URL)
        await page.wait_for_timeout(700)
        await page.evaluate(
            "() => new Promise((r) => { const q = indexedDB.deleteDatabase('yice-reader');"
            " q.onsuccess = q.onerror = q.onblocked = r; })"
        )
        await page.reload()
        await page.wait_for_timeout(800)

        # ---------------- 造数据 ----------------
        big = await page.evaluate(MAKE_BOOK, {"chapters": CHAPTERS, "pages": PAGES, "title": "大长篇"})
        for i in (1, 2, 3):
            await page.evaluate(MAKE_BOOK, {"chapters": 2, "pages": 3, "title": f"小册{i}"})
        check("造出 300 章的书", big["chapters"] == CHAPTERS and big["total"] == CHAPTERS * PAGES,
              f"{big['chapters']} 章 / {big['total']} 页")
        await page.reload()
        await page.wait_for_timeout(900)

        # ---------------- 打开：只读当前章 ----------------
        await page.evaluate("""async () => {
          const { db } = await import('/js/db.js');
          window.__calls = 0;
          const orig = db.getFile.bind(db);
          db.getFile = (id) => { window.__calls++; return orig(id); };
        }""")

        t0 = time.time()
        await page.evaluate("(id) => document.querySelector(`.card[data-id='${id}']`).click()", big["id"])
        await page.wait_for_selector("#reader:not([hidden])", timeout=20000)
        await page.wait_for_function(
            f"() => /\\/ {CHAPTERS * PAGES} 页/.test(document.querySelector('#readerPage').textContent)",
            timeout=30000,
        )
        elapsed = time.time() - t0
        calls = await page.evaluate("window.__calls")
        label = await page.locator("#readerPage").inner_text()

        check("300 章书能打开", f"/ {CHAPTERS * PAGES} 页" in label, f"{label}，{elapsed:.2f}s")
        check("打开只读 1 个分段文件", calls == 1, f"getFile x{calls}")
        check("打开耗时 < 3s", elapsed < 3.0, f"{elapsed:.2f}s")

        # ---------------- 目录不依赖解压 ----------------
        await page.evaluate("document.querySelector('[data-r=\"toc\"]').click()")
        await frame(page, 400)
        toc = await page.evaluate("document.querySelectorAll('#panelBody .toc-item').length")
        check("目录一次列出 300 章", toc == CHAPTERS, f"{toc} 项")

        await page.evaluate("[...document.querySelectorAll('#panelBody .toc-item')].pop().click()")
        await page.wait_for_timeout(1300)
        last = await page.evaluate("document.querySelector('#readerPage').textContent")
        img_ok = await page.evaluate(
            "() => { const i = document.querySelector('.comic-pages img');"
            " return i ? (i.complete && i.naturalWidth > 0) : false; }"
        )
        calls2 = await page.evaluate("window.__calls")
        check("跳到第 300 章", f"{CHAPTERS * PAGES - PAGES} / {CHAPTERS * PAGES} 页" in last
              or f"{CHAPTERS * PAGES - PAGES + 1} / {CHAPTERS * PAGES} 页" in last, last)
        check("跳章后图片真实加载", img_ok, f"naturalWidth>0 = {img_ok}")
        check("跳章只多读 1 个文件", calls2 == 2, f"累计 {calls2} 次")

        # 回到书架
        await page.keyboard.press("Escape")
        await frame(page, 600)
        if await page.evaluate("!document.querySelector('#reader').hidden"):
            await page.evaluate("document.querySelector('[data-r=\"close\"]')?.click()")
            await page.wait_for_timeout(600)

        # ---------------- 批量删除 ----------------
        cards = await page.evaluate("""() => [...document.querySelectorAll('.card')].map((c) => ({
          id: c.dataset.id,
          title: c.querySelector('.card-title')?.textContent?.trim() || '',
        }))""")
        check("书架 4 本", len(cards) == 4, str([c["title"] for c in cards]))

        targets = [c["id"] for c in cards if c["title"].startswith("小册")][:2]
        await page.evaluate("""(ids) => {
          const d = new MouseEvent('click', { bubbles: true, ctrlKey: true });
          ids.forEach((id) => document.querySelector(`.card[data-id='${id}']`).dispatchEvent(d));
        }""", targets)
        await frame(page, 300)

        bar_visible = await page.evaluate("!document.querySelector('#selectBar').hidden")
        del_label = await page.evaluate("document.querySelector('#selectDelete').textContent")
        check("多选条出现「删除 N 本」", bar_visible and "删除 2 本" in del_label, del_label)

        before = await page.evaluate(COUNT_FILES)
        await page.evaluate("document.querySelector('#selectDelete').click()")
        await frame(page, 400)
        title = await page.evaluate("document.querySelector('#confirmTitle').textContent")
        check("删除前弹确认框", "2 本" in title, title)

        await page.evaluate("document.querySelector('#confirmOk').click()")
        await page.wait_for_timeout(1600)

        left = await page.evaluate("document.querySelectorAll('.card').length")
        bar_after = await page.evaluate("document.querySelector('#selectBar').hidden")
        toast_text = await page.evaluate(
            "[...document.querySelectorAll('.toast')].map((e) => e.textContent.trim()).join(' | ')"
        )
        undo_btn = await page.evaluate("!!document.querySelector('.toast-act')")

        check("删掉后剩 2 本", left == 2, f"{left} 本")
        check("删除后自动退出多选", bar_after is True)
        check("提示删除数量", "已删除 2 本" in toast_text, toast_text)
        check("撤销窗口给了按钮", undo_btn)

        # 文件此时还没删：撤销要能原样还回来
        file_alive = await page.evaluate("""async () => {
          const { db } = await import('/js/db.js');
          const f = await db.getFile('probe-小册1-0001');
          return !!f;
        }""")
        check("撤销窗口内文件未被删除", file_alive)

        await page.evaluate("document.querySelector('.toast-act').click()")
        await page.wait_for_timeout(1200)
        back = await page.evaluate("document.querySelectorAll('.card').length")
        back_files = await page.evaluate(COUNT_FILES)
        check("撤销后书回来了", back == 4, f"{back} 本")
        check("撤销后分段记录也回来", back_files == before, f"{before} → {back_files}")

        # 再删一次，这次不撤销
        await page.evaluate("""(ids) => {
          const d = new MouseEvent('click', { bubbles: true, ctrlKey: true });
          ids.forEach((id) => document.querySelector(`.card[data-id='${id}']`).dispatchEvent(d));
        }""", targets)
        await frame(page, 300)
        await page.evaluate("document.querySelector('#selectDelete').click()")
        await frame(page, 400)
        focus_id = await page.evaluate("document.activeElement?.id")
        check("确认框默认焦点在取消", focus_id == "confirmCancel", focus_id)
        await page.evaluate("document.querySelector('#confirmOk').click()")
        await page.wait_for_timeout(1200)
        left2 = await page.evaluate("document.querySelectorAll('.card').length")
        check("二次删除生效", left2 == 2, f"{left2} 本")

        # 没选中的大书还在，且还能打开
        still = await page.evaluate(
            "(id) => !!document.querySelector(`.card[data-id='${id}']`)", big["id"]
        )
        check("没选中的书未被误删", still)
        await page.evaluate("(id) => document.querySelector(`.card[data-id='${id}']`).click()", big["id"])
        await page.wait_for_timeout(1500)
        reopen = await page.evaluate("document.querySelector('#readerPage').textContent")
        check("大书删除后仍能打开", f"/ {CHAPTERS * PAGES} 页" in reopen, reopen)
        await page.keyboard.press("Escape")
        await frame(page, 600)
        if await page.evaluate("!document.querySelector('#reader').hidden"):
            await page.evaluate("document.querySelector('[data-r=\"close\"]')?.click()")
            await page.wait_for_timeout(600)

        # ---------------- 键盘 Delete 批量删除 ----------------
        visible = await page.evaluate("""() => [...document.querySelectorAll('.card')].map((c) => c.dataset.id)""")
        await page.evaluate("""(ids) => {
          const d = new MouseEvent('click', { bubbles: true, ctrlKey: true });
          ids.slice(0, 1).forEach((id) => document.querySelector(`.card[data-id='${id}']`).dispatchEvent(d));
        }""", visible)
        await frame(page, 250)
        await page.evaluate("document.body.focus()")
        await page.keyboard.press("Delete")
        await frame(page, 400)
        kb_open = await page.evaluate("document.querySelector('#confirmDialog').open")
        check("Delete 键唤起删除确认", kb_open)
        await page.evaluate("document.querySelector('#confirmCancel').click()")
        await frame(page, 300)

        # ---------------- 撤销窗口过后文件真的被清理 ----------------
        count_store = """
        async () => {
          const { tx, reqOf } = await import('/js/storage/idb.js');
          const all = await tx('files', 'readonly', (os) => reqOf(os.getAll()));
          return (all || []).length;
        }
        """
        during = await page.evaluate(count_store)
        await page.wait_for_timeout(16500)
        after_purge = await page.evaluate(count_store)
        check("窗口内文件索引还在", during == before, f"{during} 个（应为 {before}）")
        check("窗口过后文件被真删", after_purge == before - 4, f"{during} → {after_purge}")

        os.makedirs(SHOTS, exist_ok=True)
        await page.screenshot(path=os.path.join(SHOTS, "verify9-delete.png"))

        real = [e for e in errors if "favicon" not in e and "ERR_FILE" not in e]
        check("无控制台报错", not real, " | ".join(real[:3]))

        await browser.close()

    print("\n" + ("ALL PASS" if ok else "SOME FAILED"))


asyncio.run(main())
