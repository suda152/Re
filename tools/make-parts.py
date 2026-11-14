"""生成「同一本书拆成多卷/多章」的测试素材，用于验证分段归并。

产物在 samples/parts/：
  夜航 01.cbz / 夜航 02.cbz / 夜航 03.cbz   漫画分卷
  星轨列车 第一册.epub / 第二册.epub        小说分册
  长夜手记 上.txt / 下.txt                  文本分卷
  孤岛.cbz                                  无关书籍（验证不会误合并）
"""
import os
import zipfile
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "samples", "parts")
os.makedirs(OUT, exist_ok=True)

FONT_PATHS = ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simsun.ttc", "C:/Windows/Fonts/simhei.ttf"]


def font(size):
    for p in FONT_PATHS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def gradient(w, h, top, bottom):
    img = Image.new("RGB", (w, h), top)
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        d.line([(0, y), (w, y)], fill=tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return img


def page(n, total, label):
    w, h = 900, 1300
    img = gradient(w, h, (32, 38, 50), (12, 14, 18))
    d = ImageDraw.Draw(img)
    d.rectangle([40, 40, w - 40, h - 40], outline=(200, 190, 170), width=3)
    d.text((w / 2, 200), label, font=font(58), fill=(245, 240, 230), anchor="mm")
    d.text((w / 2, 300), f"{n} / {total}", font=font(40), fill=(225, 150, 110), anchor="mm")
    d.line([(120, 420), (w - 120, 420)], fill=(150, 145, 135), width=2)
    for i in range(4):
        d.text((120, 480 + i * 110), "— 分段测试页 —", font=font(32), fill=(200, 195, 185))
    d.text((w - 90, h - 90), f"P{n:02d}", font=font(44), fill=(230, 150, 110), anchor="rs")
    return img


def build_cbz(path, start, count, label):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for i in range(count):
            n = start + i
            tmp = os.path.join(OUT, f"_p{n}.jpg")
            page(n, 99, label).save(tmp, quality=85)
            z.write(tmp, f"pages/{n:03d}.jpg")
            os.remove(tmp)


# ------------------------------------------------------------------ EPUB

def xhtml(title, paras):
    body = f"<h1>{title}</h1>" + "".join(f"<p>{p}</p>" for p in paras)
    return f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><meta charset="utf-8"/><title>{title}</title></head>
<body>{body}</body>
</html>"""


def build_epub(path, title, chapters):
    ch_files = [(f"ch{i}.xhtml", xhtml(t, ps), t) for i, (t, ps) in enumerate(chapters, start=1)]

    manifest = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>']
    spine = []
    for i, (name, _, _) in enumerate(ch_files, start=1):
        manifest.append(f'<item id="ch{i}" href="{name}" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="ch{i}"/>')

    opf = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:parts-{title}</dc:identifier>
    <dc:title>{title}</dc:title>
    <dc:creator>林澈</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    {chr(10).join('    ' + m for m in manifest)}
  </manifest>
  <spine>
    {chr(10).join('    ' + s for s in spine)}
  </spine>
</package>"""

    nav_items = "".join(f'<li><a href="{name}">{t}</a></li>' for name, _, t in ch_files)
    nav = f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>目录</title></head>
<body><nav epub:type="toc" id="toc"><h1>目录</h1><ol>{nav_items}</ol></nav></body>
</html>"""

    container = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"""

    with zipfile.ZipFile(path, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", container, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf", opf, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/nav.xhtml", nav, compress_type=zipfile.ZIP_DEFLATED)
        for name, content, _ in ch_files:
            z.writestr(f"OEBPS/{name}", content, compress_type=zipfile.ZIP_DEFLATED)


def para(*lines):
    return list(lines)


TXT_UP = """长夜手记 上

第一章 灯下

夜里写字，总要先关掉大灯，只留桌角一盏。光落下来，把纸照成一个很小的舞台。
这样写出来的句子不会太大，也不会太亮。

第二章 雨声

下雨的时候，屋顶的铁皮会响。响得久了，人就不觉得吵，反而觉得安静。
安静到能听见笔尖划过纸面的声音，像有人在很远的地方走路。
"""

TXT_DOWN = """长夜手记 下

第三章 旧信

抽屉里有一叠旧信，纸已经黄了，字迹还清楚。
写信的人早就不联系了，但那些句子还在，像是被留在了原地。

第四章 天亮

天快亮的时候，鸟先醒。它们不叫，只是在屋檐上跳来跳去。
等到第一班车经过，天就真的亮了。
"""


def build_txt(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


if __name__ == "__main__":
    build_cbz(os.path.join(OUT, "夜航 01.cbz"), 1, 4, "夜航 · 第一卷")
    build_cbz(os.path.join(OUT, "夜航 02.cbz"), 5, 3, "夜航 · 第二卷")
    build_cbz(os.path.join(OUT, "夜航 03.cbz"), 8, 2, "夜航 · 第三卷")
    build_cbz(os.path.join(OUT, "孤岛.cbz"), 50, 3, "孤岛")

    # 三本互不相关的漫画 + 一本小说，用于验证多选合并与类型校验
    build_cbz(os.path.join(OUT, "旧站.cbz"), 60, 2, "旧站")
    build_cbz(os.path.join(OUT, "夜行.cbz"), 70, 2, "夜行")
    build_epub(os.path.join(OUT, "短歌.epub"), "短歌", [
        ("第一章 · 短歌", para(
            "巷子很短，走完只要一分钟。",
            "他在巷口站了很久，像是在等一个不会来的人。")),
    ])

    build_epub(os.path.join(OUT, "星轨列车 第一册.epub"), "星轨列车 第一册", [
        ("第一章 · 倒数第二班车", para(
            "站台的灯管有一支坏掉了，每隔三秒闪一下，把候车的人都照成一半亮一半暗。",
            "这条线路他坐了七年，起初是为了上学，后来是为了上班。")),
        ("第二章 · 中途不下车", para(
            "车厢里只有四个人，还有一个抱着纸箱的年轻人。",
            "列车穿过一段没有灯的区域，窗玻璃变成了一面镜子。")),
    ])
    build_epub(os.path.join(OUT, "星轨列车 第二册.epub"), "星轨列车 第二册", [
        ("第三章 · 终点站", para(
            "到终点的时候，车上只剩下他一个人。站台上没有灯，也没有人。",
            "他下车，走了几步，回头看见列车并没有立刻开走。")),
        ("第四章 · 回程", para(
            "回去的路上，他第一次注意到这条路有多宽。",
            "以前他总是在赶时间，从来没看清过。")),
    ])

    # 文件名只剩「第 N 章」，靠 EPUB 元数据标题归并
    build_epub(os.path.join(OUT, "第一章.epub"), "孤星纪事", [
        ("第一章 起风", para("风从北边来，把晾在外面的衣服吹得笔直。", "他把窗关上一半，留一条缝。")),
    ])
    build_epub(os.path.join(OUT, "第二章.epub"), "孤星纪事", [
        ("第二章 落雨", para("雨点砸在铁皮上，声音像是有人在屋顶走路。", "他放下笔，听了一会儿。")),
    ])

    build_txt(os.path.join(OUT, "长夜手记 上.txt"), TXT_UP)
    build_txt(os.path.join(OUT, "长夜手记 下.txt"), TXT_DOWN)

    for name in sorted(os.listdir(OUT)):
        p = os.path.join(OUT, name)
        print(f"{name:28s} {os.path.getsize(p)/1024:8.1f} KB")
