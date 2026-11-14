# 从桌面版到 Android 平板 App：改造方案

> 前置条件：桌面版已通过 31 项端到端校验（导入、分页、目录、续读、双页/条漫、删除、清空、三种屏幕尺寸）。
> 本文说明**怎么把这个 Web 应用变成可安装的 Android 平板 App**，以及每一步必须改什么。
>
> **落地状态**：第 1–5 阶段已实现（项目结构、平板布局、手势/返回/安全区、存储抽象、SAF 选文件、平板默认值），
> 实际代码与验证项见 [`03-平板端实现说明.md`](./03-平板端实现说明.md)。第 6–7 阶段只做了部分降级与打包脚本，
> APK 需在装有 Android SDK 的机器上编译。

---

## 1. 结论先说

推荐用 **Capacitor** 把现有前端原样装进 Android 壳，只重写"存储"和"文件导入"两层，阅读引擎基本不动。

| 方案 | 优点 | 代价 | 适配度 |
| --- | --- | --- | --- |
| **Capacitor（推荐）** | 复用全部 UI 与阅读引擎；插件生态完整（Filesystem / Preferences / StatusBar）；后续可加 iOS | 需要原生工程与 Gradle 环境；存储层要改 | ★★★★ |
| 纯 WebView 壳 | 最轻，一天能跑起来 | 文件导入、权限、生命周期全靠自己写 JSBridge | ★★ |
| Flutter / Compose 重写 | 性能与手势最原生 | 分页排版、EPUB 解析要重写，等于重做 | ★ |

不推荐直接"用浏览器打开"：平板上的浏览器标签页会被回收，IndexedDB 在清理缓存时可能被一起清掉，几百 MB 的漫画也不适合长期放在浏览器配额里。

---

## 2. 必须先解决的四个硬问题

| 问题 | 现状（浏览器） | Android 上的风险 | 对策 |
| --- | --- | --- | --- |
| 书籍文件存哪 | IndexedDB 存 Blob | WebView 的 IndexedDB 配额有限，超大 CBZ 写入慢甚至失败；清应用数据即全丢 | 书籍文件落**应用私有目录**，IndexedDB 只存元数据 |
| 怎么选文件 | `<input type="file">` | 能弹系统选择器，但拿不到持久 URI，重启后失效 | 自定义插件走 `ACTION_OPEN_DOCUMENT` + `takePersistableUriPermission`，流式拷贝进沙盒 |
| 返回手势 | `Esc` | 系统返回手势会直接退出 App，与"退出阅读器"冲突 | `OnBackPressedCallback`：阅读器打开时先关面板→再退阅读器，最后才退出 |
| 分页高度 | CSS `100vh` | 刘海、状态栏、手势条导致可视高度不准，分栏会切错页 | `viewport-fit=cover` + `env(safe-area-inset-*)`，并用 JS 实测容器高度再分页 |

还有两个"隐性坑"：

1. **WebView 内核版本**。现版本用了 `color-mix()`（Chrome 111+）、`aspect-ratio`、`100dvh`。旧平板的 WebView 可能停在 Chrome 9x，会掉色甚至布局塌。
   → 发布时在 Play/应用内提示"请更新 Android System WebView"，或给 `color-mix` 加静态兜底色。
2. **`backdrop-filter` 的性能**。阅读器工具条和抽屉都用了高斯模糊，中低端平板上模糊层 + 大图滚动会掉帧。→ 平板降级为不透明背景（`@supports` 或按 `deviceMemory` 判断）。

---

## 3. 工程改造步骤

### 3.1 加构建（可选但建议）

桌面版是零构建的 ESM，Capacitor 需要 `webDir`。两种做法：

- **A. 保持零构建**：`capacitor.config.ts` 里 `webDir: '.'`，把 `docs/ tools/ samples/` 排除在打包外（复制脚本过滤）。改动最小。
- **B. 引入 Vite**：`npm i -D vite`，`vite build` 输出 `dist/`，`webDir: 'dist'`。后续要压缩、按需加载、Tree-shaking 时更顺。

若选 B，`jszip` 从全局脚本改成 `import JSZip from 'jszip'`，`index.html` 去掉 vendor 引用即可——其余模块不用动。

```ts
// capacitor.config.ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'cc.tomereader.yice',
  appName: '一册',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
    backgroundColor: '#121110',
  },
  plugins: {
    SplashScreen: { launchAutoHide: false },
  },
};
export default config;
```

```bash
npm i @capacitor/core @capacitor/android @capacitor/filesystem @capacitor/preferences
npx cap add android
npm run build && npx cap sync android
npx cap open android     # 或 ./gradlew assembleDebug
```

`AndroidManifest.xml` 关键项：

```xml
<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" /> <!-- 仅当需要直接读相册 -->
<application
    android:largeHeap="true"
    android:hardwareAccelerated="true"
    android:enableOnBackInvokedCallback="true" ...>
```

实际上走 SAF 时**不需要** `READ_EXTERNAL_STORAGE`（Android 10+ 分区存储），只需在选取文件时拿到临时/持久 URI 权限。

### 3.2 存储层：抽一个 `storage` 接口

现在 `js/db.js` 混了两件事：元数据 + 原始文件。改造后拆开：

```js
// js/storage/index.js
export const storage = window.Capacitor
  ? await import('./native.js')   // Android
  : await import('./web.js');     // 桌面浏览器
```

| 能力 | Web 实现 | Android 实现 |
| --- | --- | --- |
| 书籍元数据 | IndexedDB `books` | 仍用 IndexedDB（或 SQLite 插件） |
| 原始文件读写 | IndexedDB `files` 存 Blob | `Filesystem.writeFile({ directory: 'DATA', path: 'books/<bookId>/<partId>.<ext>' })`，库里只存路径；一本书可能有多个分段，目录按书建 |
| 读取文件给 JSZip | `db.getFile(id)` → Blob | `Filesystem.readFile` → base64 → `fetch('data:...')`，或 `Capacitor.convertFileSrc()` 用 `fetch(file://)` 拿 ArrayBuffer |
| 存储占用 | `navigator.storage.estimate()` | `Filesystem.stat` 累加书籍目录大小 |

要点：

- **不要用 base64 走桥**处理大文件。几十 MB 的漫画会瞬间把内存打满。优先 `convertFileSrc` + `fetch`（WebView 允许 `file://` 访问需在 `capacitor.config` 打开 `server.allowNavigation` 或使用 Capacitor 的 `https://localhost` 方案）。
- 若必须流式读，写一个原生插件返回 `ArrayBuffer`（`PluginMethod` 返回 `{ data: number[] }` 同样有序列化开销，建议只传路径，让 WebView 自己 fetch）。
- 解压后的页图不要落盘。CBZ 里的图片仍然通过 JSZip 从内存读，Android 端只把**压缩包本身**放文件系统。

### 3.3 文件导入

新增一个最小插件（Kotlin）：

```kotlin
@CapacitorPlugin(name = "BookPicker")
class BookPickerPlugin : Plugin() {
  @ActivityCallback
  private var callback: ((List<Uri>) -> Unit)? = null

  @PluginMethod
  fun pick(call: PluginCall) {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*"
      putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
      putExtra(Intent.EXTRA_MIME_TYPES, arrayOf(
        "application/epub+zip", "application/zip", "application/vnd.comicbook+zip",
        "text/plain", "application/pdf"))
    }
    startActivityForResult(call, intent, "pickerResult")
  }

  @ActivityCallback
  fun pickerResult(call: PluginCall, result: ActivityResult) {
    // 遍历 clipData，takePersistableUriPermission，复制到 filesDir/books/，
    // 最后回传 [{ name, size, path }]，JS 侧再走解析
  }
}
```

JS 侧只把 `input.click()` 换成 `BookPicker.pick()`，后续的 `parseBookFile(file)` 保持不变——把原生返回的路径包装成 `File` 对象（`fetch(path).then(r => r.blob())` 后再 `new File([blob], name)`），**导入管线零改动**。

另一种更省事的做法：`@capawesome/capacitor-file-picker` 这类现成插件已经封装了同样的逻辑，可以先接它，等需要"记住上次目录""批量后台导入"时再自研。

### 3.4 阅读器适配点

| 项 | 改法 |
| --- | --- |
| 安全区 | `index.html` 已有 `viewport-fit=cover`；`--safe-top: env(safe-area-inset-top)`，工具条 `padding-top: calc(env(safe-area-inset-top) + 8px)`，底部同理 |
| 分页高度 | 不依赖 `100vh`（地址栏/状态栏会变），在 `mount()` 后用 `getBoundingClientRect().height` 实测 `.epub-viewport`；`ResizeObserver` 已接好，平板旋转会自动重排 |
| 字体缩放 | WebView 会跟随系统字号放大，导致分页错位。加 `-webkit-text-size-adjust: 100%`，并在 `MainActivity` 里保持 `webSettings.textZoom = 100` |
| 手势翻页 | 新增 `touchstart/touchend`：横向位移 > 60px 且纵向 < 40px 时翻页；**从屏幕左/右边缘 24dp 内起手不响应**，把边缘留给系统返回手势 |
| 双指缩放 | WebView 默认会缩放整页。设置 `setBuiltInZoomControls(false)`、`setSupportZoom(false)`，漫画的缩放继续走现有的 pointer 事件实现 |
| 返回键 | `onBackPressedDispatcher.addCallback` → `window.dispatchEvent(new CustomEvent('native-back'))`，JS 侧复用现有 `onKeyDown('Escape')` 的分支逻辑；返回 `true` 阻止默认退出 |
| 屏幕常亮 | 阅读时调 `@capacitor-community/keep-awake`，退出阅读器释放 |
| 状态栏 | 阅读器全屏时隐藏状态栏（`@capacitor/status-bar`），退出时恢复 |
| 平板横屏 | 已有 `@media` 断点；建议横屏时把默认漫画模式设为「双页对开」，并允许用户在设置里改（逻辑已存在，只改默认值） |
| 屏幕宽度 | 834dp 竖屏下正文最大宽 780px 会贴边，建议平板竖屏把默认版心从「适中」调到「窄」 |

### 3.5 生命周期

- `appStateChange` → `isActive === false` 时立即 `saveNow()`，别依赖 600ms 防抖。
- WebView 被系统回收后 `book` 引用会丢，`openBook()` 必须能从数据库重建（现在已经是从 `loc` 恢复，满足）。
- 后台不要保留大图 `objectURL`：`pause` 时清空漫画缓存，`resume` 重新按当前页加载。

### 3.6 性能

| 场景 | 现状 | 改造 |
| --- | --- | --- |
| 300 页 CBZ | 按页 `objectURL`，±10 页淘汰 | 可用；若出现 OOM，改成原生缩略图 + 原图按需 |
| 100MB EPUB | 全量 `JSZip.loadAsync` | 可接受；若慢，改成"先解析 OPF 拿目录，章节按需加载"（引擎已按章取内容，只需延迟 `loadAsync`） |
| 分页测量 | 每次字号/尺寸变化重排 | Android 上 `ResizeObserver` 抖动更频繁，已有 140ms 防抖，建议提到 200ms |
| 模糊层 | `backdrop-filter: blur(14px)` | 平板按 `navigator.deviceMemory <= 4` 关掉模糊，用纯色 |

### 3.7 打包

```bash
npx cap sync android
cd android && ./gradlew bundleRelease
# 签名：android/app/build.gradle 配 signingConfigs，或 Android Studio → Generate Signed Bundle
```

- `minSdkVersion 26`（Android 8.0），`targetSdkVersion 35`。
- 平板适配声明：`<supports-screens android:largeScreens="true" android:xlargeScreens="true" />`，不锁定方向（`android:screenOrientation="fullUser"`）。
- 应用体积：JSZip 约 100KB，前端总计 < 400KB，主要体积在 WebView 壳本身。

---

## 4. 建议的改造顺序

| 阶段 | 内容 | 改动量 | 风险 |
| --- | --- | --- | --- |
| 1 | Capacitor 起壳，`webDir` 指向现有目录，跑通"能打开书架" | S | 低 |
| 2 | 存储层抽象，书籍文件落 `filesDir`，元数据仍在 IndexedDB | M | 中（大文件读写） |
| 3 | 文件导入插件（SAF + 持久权限），替换 `input[type=file]` | M | 中（权限/URI 生命周期） |
| 4 | 返回键、手势翻页、安全区、状态栏、常亮 | M | 低 |
| 5 | 平板专属默认值（双页、版心）、横竖屏回归 | S | 低 |
| 6 | 性能兜底（模糊降级、缓存淘汰、大文件测试） | M | 中 |
| 7 | 签名打包、真机回归 | S | 低 |

**验收清单（真机）**

- [ ] 平板竖屏 / 横屏各导入一本 EPUB + 一本 300 页 CBZ
- [ ] 旋转屏幕后 EPUB 不丢页码、漫画不跳页
- [ ] 系统返回手势：阅读器内先退阅读器，书架页才退出 App
- [ ] 边缘滑动不误触翻页
- [ ] 杀进程重开，书架、进度、阅读设置都在
- [ ] 双页模式下日漫 RTL 顺序正确
- [ ] 连续阅读 30 分钟无掉帧、无 OOM
- [ ] 深色 / 米黄主题下工具条与状态栏配色一致

---

## 5. 哪些代码可以原样搬

| 模块 | 是否改动 |
| --- | --- |
| `js/reader-epub.js` 分栏分页 | 不动（只加实测高度） |
| `js/reader-comic.js` 单页/双页/条漫 | 不动（加手势入口） |
| `js/epub-parse.js` | 不动 |
| `js/library.js` / `css/*` | 不动（加安全区变量） |
| `js/db.js` | 拆成 `metadata` + `files` 两个实现 |
| `js/main.js` 的导入入口 | 换成插件调用 |
| `vendor/jszip.min.js` | 可改为 npm 依赖 |

也就是说，**大约 80% 的前端代码可以直接复用**，真正要写的是：一个存储适配层（~200 行）、一个文件选择插件（~120 行 Kotlin）、一段返回键与手势桥接（~60 行）。
