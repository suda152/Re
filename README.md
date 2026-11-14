# Re · 漫画与小说阅读器（桌面 / 平板 / Android App）

参考 <https://tomereader.cc/> 的功能设计做的本地阅读器：书架、导入、EPUB 分栏阅读、CBZ 单页/双页/条漫、目录、阅读设置、进度续读、存储管理。
**所有书籍只存在本机，不上传任何服务器。**

同一份代码有三种跑法：浏览器窗口、浏览器平板尺寸、装成 Android 平板 App（Capacitor）。宽度够时自动切到平板布局，见 `docs/03-平板端实现说明.md`。

---

## 运行

需要 Node.js（本机已有 v22）。

**Windows**：双击 `start.bat`，会启动本地服务并用 Edge/Chrome 的应用窗口打开。

**其他方式**：

```bash
node serve.mjs          # 然后打开 http://127.0.0.1:5178/
# 或
npm run start           # 等价
```

> 不能直接双击 `index.html`：ES 模块和 IndexedDB 需要 http(s) 环境。端口可用 `PORT=5179 node serve.mjs` 改。

## 平板 / Android App

```bash
android/build-apk.bat  # 一键出包：www/ → cap sync → assembleDebug
npm run build          # 或者分步：tools/build-www.mjs 生成 www/，再 cap sync android
npx cap open android   # 用 Android Studio 打开（需要 JDK 17 + Android SDK 34）
npm run apk            # 或命令行直接出 debug 包：cd android && gradlew.bat assembleDebug
```

产物在 `android/app/build/outputs/apk/debug/app-debug.apk`（约 3.7 MB，debug 签名）。
本机已装好工具链：JDK 17 在 `D:\Softwares\Android\jdk-17.0.21+9`，SDK 在 `D:\Softwares\Android\sdk`，
`android/build-apk.bat` 里固化了这两个路径，不需要把它们加进系统 PATH。

```bash
# 装到平板（先开 USB 调试）
D:\Softwares\Android\sdk\platform-tools\adb.exe install -r android/app/build/outputs/apk/debug/app-debug.apk

| 场景 | 布局 |
| --- | --- |
| ≥1000px 横屏 | 侧栏展开 208px；书籍详情从**右侧面板**滑出；阅读器目录是**常驻左栏**，正文让位 |
| 竖屏平板 / 中等宽度 | 侧栏收成图标条；详情居中弹窗；目录是覆盖式抽屉 |
| 触屏 | 按钮与卡片加大到 44px；左右轻扫翻页（边缘 24px 留给系统）；书架可按住滑动连选 |
| 系统返回 | 面板 → 阅读器 → 对话框 → 右键菜单 → 多选，都没有才退出 App |
| 刘海 / 手势条 | `env(safe-area-inset-*)` + 原生实测 inset 取大值，写到 `--safe-*` 变量 |
| 低性能设备 | `data-perf="low"` 时关掉工具条与抽屉的高斯模糊 |

安卓侧改动：`MainActivity`（关 WebView 缩放与字号跟随、边缘到边缘、推 inset）、`BookPickerPlugin`（SAF 多选 + 持久授权 + 流式复制）、`AndroidManifest`（largeHeap、`fullUser` 方向、不锁横竖屏）。书籍文件在 App 私有目录，IndexedDB 只留索引。

## 支持格式

| 格式 | 导入 | 阅读 |
| --- | --- | --- |
| `.epub` | ✅ 解析标题/作者/封面/目录 | ✅ 分栏分页、目录跳转、字体主题 |
| `.cbz` / `.zip` | ✅ 图片自然排序、首页封面 | ✅ 单页 / 双页 / 条漫、RTL、缩放 |
| `.txt` / `.md` | ✅ 自动按「第 N 章」分章 | ✅ 与 EPUB 相同的排版 |
| `.pdf` | ✅ | ⚠️ 用浏览器内置查看器，不记录页码 |
| `.cbr` | ❌ 提示需转成 CBZ（RAR 未支持） | — |

## 多卷 / 分章导入

一本书可以由多个文件组成。文件名带卷或章编号时（`第01卷`、`第十二章`、`ch03`、`vol.2`、`[01]`、`夜航 - 05`、`三体2`、`上册/下册`），同类型且书名主干相同的文件会归到同一本书，按编号排序：

- 一次选中多个分卷文件导入 → 合成一本；
- 之后单独导入下一卷 → 自动追加到已有书目（不会多出一本）；
- 文件名对不上时，右键书卡 →「合并到另一本」手动并进去；
- 书名都对不上（比如一堆散装文件）时，**多选一次合并**（见下节）；
- 没有编号的文件不会被误合并，4 位年份（`夜航（2019）`）也不当卷号。

测试素材：`python tools/make-parts.py` 会在 `samples/parts/` 生成三组分卷文件。

## 多选合并

把已经散成好几本的同一套书一次性并回一本：

| 操作 | 效果 |
| --- | --- |
| 顶栏「多选」按钮 | 进入多选模式（触屏没有 Ctrl 键时走这里） |
| `Ctrl` / `Cmd` + 点击卡片 | 逐本加入或移出选择 |
| `Shift` + 点击 | 从上一本到这一本的范围全选 |
| `Ctrl + A` / 顶栏「全选」 | 全选当前筛选出的书（再点取消全选） |
| 按住并划过卡片 | 拖动 / 滑动连续选中，起点已选中时整段取消 |
| 空白处拖出选框 | 拉框选中范围内的书（鼠标） |
| 拖到列表上下边缘 | 自动滚屏接着选 |
| 右键 →「选择（可多选合并）」 | 进入多选并选中这一本 |
| 已有多选时单击卡片 | 切换选中；双击才打开这本书 |
| `Esc` | 退出多选 |

选中后底部出现操作条，显示「已选 N 本 · M 章 → 1 本」，点「合并为一本」：

- 弹出确认框，逐本列出，选一行决定**保留哪本的书名、封面与阅读进度**（默认选分段最多、其次进度最高的那本）；
- 合并按卷/章编号重新排序，跨书交错也能排对（第一册在 A 本、第二册在 B 本，合完仍是 1→2）；
- 只有同类型能合并，混选或包含 PDF 时按钮会禁用并说明原因；
- 其余书目从书架移除，文件仍保留在新书里，不会重复占用空间；
- 合并完成后弹出结果面板，**按章节列出**「第 N 章 · 文件名 · 页数」，新并入的章节高亮，可直接开始阅读；书架与详情页也改为「4 章 · 11 页」这种按章区分的写法。

## 批量导入（几百话漫画）

右上角「导入」在 Android 壳里会先问一次 **选择文件 / 选择文件夹**：

- **选择文件夹** → 系统目录选择器选 `Download/manga` → 原生递归枚举 → 确认「发现 312 个文件，约 18.4 GB」→ 逐个写入，每 20 个一批入库；
- 进度面板显示「87 / 312 · 第088话」，**随时可停**，已入库的部分保留、可立即阅读；
- 已经在书架里的文件按「文件名 + 大小」跳过，不会重复占空间；导入结束会自动清掉中断留下的残片；
- 设置 → 数据 → 「清理缓存」可清掉系统选择器复制文件时的临时副本。

实现：文件不经过 WebView，原生直接写 `files/books/`，页数与封面用 `ZipFile` 读中央目录（只读几十 KB），因此几百话也不会把内存打满。设计与实测数据见 **[docs/04-批量导入方案.md](docs/04-批量导入方案.md)**。

打包工具（把散图目录规范成 `书名 第001话.cbz`，PC 端运行，无第三方依赖）：

```bash
node tools/pack-manga.mjs "D:/manga/葬送的芙莉莲" --dry-run   # 先体检
node tools/pack-manga.mjs "D:/manga/葬送的芙莉莲"              # 一话一个 CBZ
node tools/pack-manga.mjs "D:/manga/海贼王" --bundle 50        # 顺带打传输包
```

## 快捷键

| 键 | 作用 |
| --- | --- |
| `←` `→` / `PageUp` `PageDown` / `空格` | 翻页（漫画 RTL 时方向对调） |
| `T` | 目录 |
| `F` | 全屏 |
| `Esc` | 关闭面板 / 退出阅读器 |
| `Ctrl + 滚轮` | 调字号（EPUB）或缩放（漫画） |
| `/` | 书架页聚焦搜索 |
| `Ctrl + A` | 书架页全选（进入多选） |

鼠标：点击正文左右 26% 区域翻页，点中间显示/隐藏工具条；右键书卡有菜单。

## 目录

```
index.html
css/            界面、阅读器、tablet.css（平板适配层，最后加载）
js/             主逻辑（见 docs/01）
  platform.js   平台探测：平板/桌面、横竖屏、安全区
  native.js     Capacitor 桥：返回键、状态栏、常亮、SAF 选文件
  storage/      文件存储：web（IndexedDB Blob）/ native（私有目录 + 索引）
vendor/         jszip
www/            npm run build 生成的产物（Capacitor 的 webDir）
android/        安卓原生工程
samples/        测试样书（parts/ 下是多卷素材）
tools/          样书生成、打包工具 pack-manga.mjs、build-www、Playwright 校验脚本
docs/           功能与交互、Android 改造方案、平板端实现说明、批量导入方案
serve.mjs       本地静态服务器
start.bat/.sh   启动脚本
```

## 自测

```bash
python -m pip install playwright pillow
python tools/make-samples.py      # 生成 samples/
python tools/make-parts.py        # 生成 samples/parts/（多卷素材）
python tools/verify2.py           # 需要本机 Edge；启动 serve.mjs 后运行
python tools/verify5.py           # 多卷归并 / 手动合并
python tools/verify6.py           # 多选合并
python tools/verify7.py           # 拖动连选 / 一键全选 / 合并结果按章
python tools/verify8.py           # 平板：六种视口 × 横竖屏、手势、返回、安全区
```

`verify2.py` 覆盖 31 项检查：导入/重复导入拦截、EPUB 分页与跨章翻页、字号变化后重新分页、目录跳转、主题切换、进度回写与续读、漫画单页/双页/条漫、双击/删除/清空、三种视口无横向溢出、无控制台报错。

`verify5.py` 覆盖 16 项：6 个分卷文件归为 3 本、书名去卷号、跨卷翻页与目录跳转、第二批追加、无关书籍不误合并、手动合并、删除时清理全部分段文件。

`verify7.py` 覆盖 40 项：拖动连选（起点、范围回缩、已选起手取消、松手后 click 不翻转）、顶栏与底栏一键全选、合并结果面板按章节列出并高亮新并入、书架 / 详情 / 漫画目录按章展示、窄屏下全选仍可达、原有 Ctrl/Shift/Esc 逻辑回归。

`verify8.py` 覆盖 60 项平板适配：1024×768 / 768×1024 / 1194×834 / 834×1194 / 960×600 / 1280×800 六种视口下的平台判定、无横向溢出、侧栏与书架密度；横屏详情右侧面板与竖屏居中弹窗；手势翻页（前进/后退/边缘不响应/纵向不翻页/补发 click 不重复翻页）；目录常驻左栏与正文让位；返回层级（面板→阅读器）；原生 inset 注入；旋转后重排不丢书；触摸点击唤出 / 收起工具条；桌面不被误判。

`verify6.py` 覆盖 40 项多选合并：Ctrl/Shift/Ctrl+A 选择与计数、操作条状态与命中栈、合并对话框（列出书目、默认主书）、合并后体量与页数、合并结果可读且能翻到末页、类型不一致拦截、Esc/双击/切视图清空、筛选后保留选择、删除后自动清理。

> 本机 Edge 无 GPU（SwiftShader）时，Playwright 连续交互若干次后会丢失坐标输入（点击不产生任何 DOM 事件，但 `elementsFromPoint` 正常）。`verify6.py` 因此改用事件派发驱动业务流程，并单独断言「目标位于命中栈顶层且 `pointer-events: auto`」来覆盖真实点击可达性。

## 已知限制

- 单本 400MB、最多 5000 本、单本 2000 分段；超出会提示。
- 阅读设置按书保存；「设置 → 阅读默认值」只影响之后新打开的书。
- 清空浏览器站点数据会连同书一起删掉。
- 没有做中英切换与教程独立页（参考站有）。
- 批量导入只在 Android 壳里可用；浏览器仍是一次选文件（拖拽可多选）。
- 浏览器书库与 App 书库互不相通：装 App 后需要重新导入一次。
- PDF 仍交给 WebView 内置查看器，不记录页码。

平板改造方案见 `docs/02-Android平板改造方案.md`，实际落地情况与验证项见 `docs/03-平板端实现说明.md`。
