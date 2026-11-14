# 应用图标：以豆包生成的漫画漩涡图为源，裁切后栅格化全套启动器图标
# 源图 assets/icon-src.jpg (1920x1920)，主体圆角方块 bounds(281,280,1356²)，圆角 ~18%
import asyncio, base64, os
from PIL import Image
from playwright.async_api import async_playwright

ROOT = r"D:\agentwork\wb\spaces\2026_11_13_19-50-55\tome-app"
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
SRC = os.path.join(ROOT, "assets", "icon-src.jpg")
ART = os.path.join(ROOT, "assets", "icon-art.png")
RADIUS = 18  # 主体圆角占边长百分比

DPI = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
LEGACY_BASE = 48     # ic_launcher / ic_launcher_round，48dp 基准
ADAPT_BASE = 108     # ic_launcher_foreground，108dp 基准
FG_SCALE = 72        # 前景图占画布百分比（安全区内，漩涡居中不被裁）


def prepare_art():
    """精确裁出主体圆角方块（右下的水印与空白不要），存成干净的方形 PNG（1024px）"""
    im = Image.open(SRC).convert("RGB")
    art = im.crop((281, 280, 281 + 1356, 280 + 1356))
    art = art.resize((1024, 1024), Image.LANCZOS)
    art.save(ART)
    print("art saved:", ART, art.size)


async def render(page, size, round_mask=False, fg_scale=0):
    """fg_scale>0 时画前景层：透明画布 + 居中缩放的主体图"""
    art_uri = "data:image/png;base64," + base64.b64encode(open(ART, "rb").read()).decode()
    if fg_scale:
        inner = round(size * fg_scale / 100)
        pad = (size - inner) // 2
        html = (f"<!DOCTYPE html><html><head><meta charset='utf-8'><style>"
                f"body{{margin:0;background:transparent}}"
                f".c{{width:{size}px;height:{size}px;position:relative}}"
                f".c img{{position:absolute;left:{pad}px;top:{pad}px;width:{inner}px;height:{inner}px}}"
                f"</style></head><body><div class='c'><img src='{art_uri}'></div></body></html>")
        await page.set_content(html)
        return await page.locator(".c").screenshot(omit_background=True)

    mask = f"img{{border-radius:{RADIUS}%}}"
    if round_mask:
        mask = "img{clip-path:circle(50% at 50% 50%)}"
    html = (f"<!DOCTYPE html><html><head><meta charset='utf-8'><style>"
            f"body{{margin:0;background:transparent}}"
            f"img{{display:block;width:{size}px;height:{size}px}}{mask}"
            f"</style></head><body><img src='{art_uri}'></body></html>")
    await page.set_content(html)
    return await page.locator("img").screenshot(omit_background=True)


async def main():
    prepare_art()
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="msedge", headless=True)
        page = await browser.new_page(viewport={"width": 512, "height": 512}, device_scale_factor=1)

        for dpi, mul in DPI.items():
            outdir = os.path.join(RES, f"mipmap-{dpi}")
            os.makedirs(outdir, exist_ok=True)

            legacy = round(LEGACY_BASE * mul)
            fg = round(ADAPT_BASE * mul)

            await page.goto("about:blank")
            open(os.path.join(outdir, "ic_launcher.png"), "wb").write(await render(page, legacy))
            await page.goto("about:blank")
            open(os.path.join(outdir, "ic_launcher_round.png"), "wb").write(await render(page, legacy, round_mask=True))
            await page.goto("about:blank")
            open(os.path.join(outdir, "ic_launcher_foreground.png"), "wb").write(await render(page, fg, fg_scale=FG_SCALE))

            print(f"mipmap-{dpi}: launcher {legacy}px, round {legacy}px, foreground {fg}px")

        # PWA / 网页图标
        await page.goto("about:blank")
        open(os.path.join(ROOT, "assets", "icon-192.png"), "wb").write(await render(page, 192))
        await page.goto("about:blank")
        open(os.path.join(ROOT, "assets", "icon-512.png"), "wb").write(await render(page, 512))
        print("web icons: 192px + 512px")

        await browser.close()
        print("ICONS_OK")


asyncio.run(main())
