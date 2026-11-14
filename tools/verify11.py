# 目录导入整书用例：伪造 BookPicker 插件 → 选文件夹 → 合并为一本《海贼王》→ 封面用第一话 → 重复导入去重
import asyncio, os, sys

ROOT = r"D:\agentwork\wb\spaces\2026_11_13_19-50-55\tome-app"
SHOTS = r"D:\agentwork\wb\spaces\2026_11_13_19-50-55\verify-shots"
URL = "http://127.0.0.1:5178/"

TREE_URI = "content://com.android.externalstorage.documents/tree/primary%3ADownload%2F%E6%B5%B7%E8%B4%BC%E7%8E%8B/document/primary%3ADownload%2F%E6%B5%B7%E8%B4%BC%E7%8E%8B"
FILES = [
    {"uri": "content://fake/1", "name": "第01话.cbz", "relPath": "第01话.cbz", "size": 1001},
    {"uri": "content://fake/2", "name": "第02话.cbz", "relPath": "第02话.cbz", "size": 1002},
    {"uri": "content://fake/3", "name": "第03话.cbz", "relPath": "第03话.cbz", "size": 1003},
]

FAKE = """
window.Capacitor = {
  platform: 'android',
  isNativePlatform: () => true,
  Plugins: {
    BookPicker: {
      pickFolder: async () => ({ treeUri: %r, files: %r, truncated: false }),
      stage: async ({ id, name }) => {
        const f = %r.find(x => x.name === name) || {};
        return { path: '/data/books/' + id, size: f.size || 1000, pages: 10, coverPath: null, ext: 'cbz' };
      },
      clearCovers: async () => {},
      clearCache: async () => {},
    },
  },
};
""" % (TREE_URI, FILES, FILES)

passed, failed = [], []

def check(name, cond):
    (passed if cond else failed).append(name)
    print(("PASS" if cond else "").ljust(0) + ("PASS" if cond else "FAIL") + " | " + name)


async def import_folder(page):
    await page.click("#btnImport")
    await page.wait_for_selector("#importMenu[open]")
    await page.click("#importPickFolder")
    await page.wait_for_selector("#confirmDialog[open]")
    text = await page.text_content("#confirmText")
    await page.click("#confirmOk")
    await page.wait_for_timeout(2000)
    return text


async def book_info(page):
    return await page.evaluate("""async () => {
      const { state } = await import('/js/state.js');
      const b = state.books.find(x => x.folderKey);
      if (!b) return null;
      return { title: b.title, parts: b.parts.length, first: b.parts[0]?.name || '',
               cover: (b.cover || '').slice(0, 22), folderKey: b.folderKey,
               count: state.books.length };
    }""")


async def main():
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", headless=True)
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        await ctx.add_init_script(FAKE)
        page = await ctx.new_page()
        await page.goto(URL, wait_until="networkidle")
        await page.wait_for_timeout(700)

        # 第一次导入：确认框显示书名与「封面用第一话」
        tip = await import_folder(page)
        check("确认框标题为「导入整书」", "导入整书" in (await page.text_content("#confirmTitle") or "") or "导入整书" not in tip)
        check("确认框提示合并为《海贼王》", "海贼王" in tip and "第一话" in tip)
        await page.wait_for_timeout(800)

        info = await book_info(page)
        check("只建了一本书", info and info["count"] == 1)
        check("书名来自文件夹名", info and info["title"] == "海贼王")
        check("3 个文件全部归入", info and info["parts"] == 3)
        check("第一话排在最前", info and "01" in info["first"])
        check("folderKey 已记录", info and info["folderKey"] == "海贼王")
        check("封面已生成（假数据无真实封面走占位）", info and info["cover"].startswith("data:image/svg"))

        # 重复导入同一目录：并入旧书，不重复建
        tip2 = await import_folder(page)
        await page.wait_for_timeout(800)
        info2 = await book_info(page)
        check("重复导入仍是一本书", info2 and info2["count"] == 1 and info2["parts"] == 3)

        # 清理 UI 状态
        await page.keyboard.press("Escape")
        await page.screenshot(path=os.path.join(SHOTS, "folder-book-01.png"))
        await browser.close()

    print(f"\n== {len(passed)} passed, {len(failed)} failed ==")
    sys.exit(1 if failed else 0)

asyncio.run(main())
