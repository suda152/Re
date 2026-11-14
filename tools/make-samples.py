"""生成用于验证阅读器的样本书：epub / cbz / txt。

这些文件只是测试素材，内容为原创占位文本。
"""
import os
import zipfile
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "samples")
os.makedirs(OUT, exist_ok=True)

FONT_CANDIDATES = [
    ("C:/Windows/Fonts/msyh.ttc", 0),
    ("C:/Windows/Fonts/msyhbd.ttc", 0),
    ("C:/Windows/Fonts/simsun.ttc", 0),
    ("C:/Windows/Fonts/simhei.ttf", 0),
]


def font(size, bold=False):
    order = FONT_CANDIDATES if not bold else [FONT_CANDIDATES[1]] + FONT_CANDIDATES
    for path, idx in order:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size, index=idx)
            except Exception:
                continue
    return ImageFont.load_default()


def vgradient(w, h, top, bottom):
    img = Image.new("RGB", (w, h), top)
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        c = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        d.line([(0, y), (w, y)], fill=c)
    return img


def centered(draw, box, text, f, fill):
    x0, y0, x1, y1 = box
    bbox = draw.textbbox((0, 0), text, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text((x0 + (x1 - x0 - tw) / 2 - bbox[0], y0 + (y1 - y0 - th) / 2 - bbox[1]), text, font=f, fill=fill)


# ---------------------------------------------------------------- 封面

def make_cover(path, title, subtitle, top=(38, 46, 58), bottom=(14, 16, 20)):
    w, h = 800, 1100
    img = vgradient(w, h, top, bottom)
    d = ImageDraw.Draw(img)
    d.rectangle([34, 34, w - 34, h - 34], outline=(235, 225, 205, 60), width=2)
    d.text((w / 2, 130), "一 册", font=font(30), fill=(230, 220, 200), anchor="mm")
    d.line([(w / 2 - 70, 175), (w / 2 + 70, 175)], fill=(200, 120, 80), width=3)

    f = font(76, bold=True)
    lines = [title[i:i + 5] for i in range(0, len(title), 5)] or [title]
    y = 440 - (len(lines) - 1) * 55
    for line in lines:
        d.text((w / 2, y), line, font=f, fill=(245, 240, 230), anchor="mm")
        y += 110

    d.text((w / 2, h - 210), subtitle, font=font(28), fill=(200, 190, 175), anchor="mm")
    d.text((w / 2, h - 140), "SAMPLE EDITION", font=font(18), fill=(150, 140, 128), anchor="mm")
    img.save(path, quality=90)


# ---------------------------------------------------------------- EPUB

CHAPTERS = [
    ("第一章 · 倒数第二班车", [
        "站台的灯管有一支坏掉了，每隔三秒闪一下，把候车的人都照成一半亮一半暗。林澈把票根捏在手里，纸边已经起了毛。",
        "这条线路他坐了七年。起初是为了上学，后来是为了上班，再后来只是为了在一天结束以前，有一段谁也不认识他的时间。",
        "广播响了两次，第一次说列车晚点八分钟，第二次什么也没说，只是把同样的电子音重复了一遍，像在确认自己还活着。",
        "站台尽头有个穿灰色外套的女人，一直在看一块没有亮起来的手机屏幕。她抬头的时候，林澈发现她在数车厢，一节一节地数。",
        "列车进站时带起一阵风，把地上的传单卷起来，贴在他的小腿上。他低头看了一眼，是一张很旧的演出海报，日期是十年前的今天。",
        "他忽然想起，十年前的这个晚上，他也在这个站台，也错过了同一班车。那时候他以为错过一次没什么，后来才知道有些车一天只有一班。",
        "车门开了。他走进去，找了个靠窗的位置坐下，把额头贴在玻璃上。玻璃是凉的，外面的城市正在往后退，退成一条条模糊的光。",
    ]),
    ("第二章 · 中途不下车", [
        "车厢里只有四个人。除了他，还有一个抱着纸箱的年轻人，一对靠在一起打瞌睡的老夫妻。",
        "纸箱上用黑色马克笔写着一个地址，字迹被雨气泡过，边缘化开了。年轻人一直用手护着箱子的一个角，好像那里装着会碎的东西。",
        "列车穿过一段没有灯的区域。窗玻璃变成了一面镜子，映出车厢里的样子，也映出他脸上的疲惫。他不太喜欢在夜里看见自己。",
        "过了很久，年轻人忽然问他：这班车到终点要多久。他说不知道，坐了七年，从没坐到过终点。",
        "年轻人笑了一下，说那正好，我也不知道要去哪。两个人在空荡的车厢里笑了一会儿，声音很快就散掉了。",
        "老夫妻中的一个醒了，从布袋里摸出两个橘子，分给他们一人一个。橘子有点酸，但是很凉，汁水沾在手指上，黏黏的。",
    ]),
    ("第三章 · 终点站", [
        "到终点的时候，车上只剩下他一个人。车门打开，站台上没有灯，也没有人。",
        "他下车，走了几步，回头看见列车并没有立刻开走，而是停在那里，像一个终于可以休息的东西。",
        "出口的闸机是坏的，栏杆一直开着。他走过去，没有刷卡，票根还在手里，已经被汗浸软了。",
        "外面是一条很安静的街，便利店的灯是这条街上最亮的东西。他进去买了一瓶水，店员抬头看了他一眼，说，好久没见你这么晚。",
        "他说，坐过站了。店员说，那也没关系，反正明天还得坐。",
        "他站在便利店门口把水喝完，把瓶子扔进回收桶，然后往回走。走到一半，他停下来，把那张票根扔进了垃圾桶。",
        "回去的路上，他第一次注意到这条路有多宽。以前他总是在赶时间，从来没看清过。",
    ]),
]

CSS = """
body { margin: 0; padding: 0; font-family: serif; line-height: 1.8; }
h1 { font-size: 1.5em; text-align: center; margin: 1.2em 0; }
p { text-indent: 2em; margin: 0 0 .8em; }
.cover { text-align: center; margin-top: 2em; }
"""


def xhtml(title, body):
    return f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><meta charset="utf-8"/><title>{title}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>{body}</body>
</html>"""


def build_epub(path):
    cover_path = os.path.join(OUT, "_cover.jpg")
    make_cover(cover_path, "星轨列车", "林 澈 · 短篇集")

    ch_files = []
    for i, (title, paras) in enumerate(CHAPTERS, start=1):
        body = f"<h1>{title}</h1>" + "".join(f"<p>{p}</p>" for p in paras)
        if i == 2:
            body += '<p style="text-align:center"><img src="images/plate.jpg" alt="插图"/></p>'
        ch_files.append((f"ch{i}.xhtml", xhtml(title, body)))

    manifest = [
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
        '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
        '<item id="style" href="style.css" media-type="text/css"/>',
        '<item id="cover-img" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>',
        '<item id="plate" href="images/plate.jpg" media-type="image/jpeg"/>',
    ]
    spine = []
    for i, (name, _) in enumerate(ch_files, start=1):
        manifest.append(f'<item id="ch{i}" href="{name}" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="ch{i}"/>')

    opf = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:sample-starlight-0001</dc:identifier>
    <dc:title>星轨列车</dc:title>
    <dc:creator>林澈</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:publisher>一册样书</dc:publisher>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    {chr(10).join('    ' + m for m in manifest)}
  </manifest>
  <spine toc="ncx">
    {chr(10).join('    ' + s for s in spine)}
  </spine>
</package>"""

    nav_items = "".join(f'<li><a href="{name}">{title}</a></li>' for (name, _), (title, _) in zip(ch_files, CHAPTERS))
    nav = f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>目录</title></head>
<body><nav epub:type="toc" id="toc"><h1>目录</h1><ol>{nav_items}</ol></nav></body>
</html>"""

    points = "".join(
        f'<navPoint id="np{i}" playOrder="{i}"><navLabel><text>{title}</text></navLabel><content src="{name}"/></navPoint>'
        for i, ((name, _), (title, _)) in enumerate(zip(ch_files, CHAPTERS), start=1)
    )
    ncx = f"""<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="urn:uuid:sample-starlight-0001"/></head>
<docTitle><text>星轨列车</text></docTitle>
<navMap>{points}</navMap>
</ncx>"""

    container = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"""

    plate = vgradient(900, 560, (52, 60, 74), (22, 24, 30))
    d = ImageDraw.Draw(plate)
    d.rectangle([40, 40, 860, 520], outline=(200, 160, 120), width=2)
    centered(d, (0, 200, 900, 360), "夜 行 的 列 车", font(52), (235, 228, 214))
    plate_path = os.path.join(OUT, "_plate.jpg")
    plate.save(plate_path, quality=88)

    with zipfile.ZipFile(path, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", container, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf", opf, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/nav.xhtml", nav, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/toc.ncx", ncx, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/style.css", CSS, compress_type=zipfile.ZIP_DEFLATED)
        for name, content in ch_files:
            z.writestr(f"OEBPS/{name}", content, compress_type=zipfile.ZIP_DEFLATED)
        z.write(cover_path, "OEBPS/images/cover.jpg", compress_type=zipfile.ZIP_STORED)
        z.write(plate_path, "OEBPS/images/plate.jpg", compress_type=zipfile.ZIP_STORED)

    for p in (cover_path, plate_path):
        if os.path.exists(p):
            os.remove(p)


# ---------------------------------------------------------------- CBZ

PAGE_W, PAGE_H = 1200, 1700


def make_page(n, total, palette):
    img = vgradient(PAGE_W, PAGE_H, palette[0], palette[1])
    d = ImageDraw.Draw(img)
    # 分格
    top = 150
    d.rectangle([70, top, PAGE_W - 70, 900], outline=(240, 235, 225), width=4)
    d.rectangle([70, 940, PAGE_W - 70, PAGE_H - 150], outline=(240, 235, 225), width=4)
    d.text((100, top + 50), f"PAGE {n:02d}", font=font(64, bold=True), fill=(250, 246, 238))
    d.text((100, top + 150), "夜 航 · 样 张", font=font(40), fill=(220, 210, 195))
    for i in range(5):
        y = top + 260 + i * 90
        d.line([(120, y), (PAGE_W - 140, y)], fill=(190, 180, 166), width=3)
    d.text((110, 1000), "— 测试页面，用于检查翻页顺序与对开排版 —", font=font(34), fill=(225, 218, 206))
    # 大页码，便于核对
    d.text((PAGE_W - 120, PAGE_H - 110), f"{n}/{total}", font=font(56, bold=True), fill=(230, 150, 110), anchor="rs")
    d.rectangle([0, 0, PAGE_W - 1, PAGE_H - 1], outline=(90, 84, 76), width=2)
    return img


def build_cbz(path, total=12):
    palettes = [
        ((30, 36, 48), (12, 14, 18)),
        ((44, 34, 34), (16, 12, 12)),
        ((26, 40, 42), (10, 16, 18)),
    ]
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for i in range(1, total + 1):
            img = make_page(i, total, palettes[(i - 1) % len(palettes)])
            tmp = os.path.join(OUT, f"_p{i}.jpg")
            img.save(tmp, quality=86)
            z.write(tmp, f"pages/{i:03d}.jpg")
            os.remove(tmp)


# ---------------------------------------------------------------- TXT

TXT = """长夜手记

第一章 灯下

夜里写字，总要先关掉大灯，只留桌角一盏。光落下来，把纸照成一个很小的舞台。
这样写出来的句子不会太大，也不会太亮。

第二章 雨声

下雨的时候，屋顶的铁皮会响。响得久了，人就不觉得吵，反而觉得安静。
安静到能听见笔尖划过纸面的声音，像有人在很远的地方走路。

第三章 旧信

抽屉里有一叠旧信，纸已经黄了，字迹还清楚。
写信的人早就不联系了，但那些句子还在，像是被留在了原地。

第四章 天亮

天快亮的时候，鸟先醒。它们不叫，只是在屋檐上跳来跳去。
等到第一班车经过，天就真的亮了。
"""


def build_txt(path):
    with open(path, "w", encoding="utf-8") as f:
        f.write(TXT)


if __name__ == "__main__":
    build_epub(os.path.join(OUT, "星轨列车.epub"))
    build_cbz(os.path.join(OUT, "夜航.cbz"))
    build_txt(os.path.join(OUT, "长夜手记.txt"))
    for name in sorted(os.listdir(OUT)):
        p = os.path.join(OUT, name)
        print(f"{name:24s} {os.path.getsize(p)/1024:8.1f} KB")
