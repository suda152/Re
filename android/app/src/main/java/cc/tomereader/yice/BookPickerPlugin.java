package cc.tomereader.yice;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * 系统文件选择器（SAF）
 *
 * 三个入口：
 *   pick()       —— 选文件（可多选），复制到 cacheDir/picked 后交回 JS
 *   pickFolder() —— 选整个目录（ACTION_OPEN_DOCUMENT_TREE），原生递归枚举后只返回清单
 *   stage()      —— 把清单里的一个文件直接写进私有书库，顺手数页数、抽首图做封面
 *
 * 目录导入为什么这样拆：
 *   1. 枚举与落盘都在原生做，JS 只拿元数据，几百话也不会把 WebView 内存打满；
 *   2. stage 直接写 getFilesDir()/books，不经过 cacheDir，省掉一份等体积副本；
 *   3. 页数与封面用 ZipFile 读中央目录，只读几十 KB，不解压整包。
 */
@CapacitorPlugin(name = "BookPicker")
public class BookPickerPlugin extends Plugin {

    /** 单次目录导入的文件数上限，超过就截断并告知 JS */
    private static final int MAX_FILES = 5000;
    /** 目录递归深度上限，防止异常结构把栈打穿 */
    private static final int MAX_DEPTH = 8;

    private static final String[] BOOK_EXT = {
            "cbz", "zip", "epub", "txt", "md", "markdown", "pdf", "cbr", "rar"
    };
    private static final String[] IMG_EXT = {
            "jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"
    };

    /* ==================== 选文件（原有行为） ==================== */

    @PluginMethod
    public void pick(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "application/epub+zip",
                "application/zip",
                "application/vnd.comicbook+zip",
                "application/x-cbz",
                "text/plain",
                "application/pdf",
                "application/octet-stream"
        });
        startActivityForResult(call, intent, "pickerResult");
    }

    @ActivityCallback
    private void pickerResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK) {
            call.reject("cancelled");
            return;
        }

        Intent data = result.getData();
        if (data == null) {
            call.reject("empty result");
            return;
        }

        List<Uri> uris = new ArrayList<>();
        if (data.getClipData() != null) {
            for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                uris.add(data.getClipData().getItemAt(i).getUri());
            }
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }

        File dir = new File(getContext().getCacheDir(), "picked");
        // 上一轮的临时副本没有回收过，会白占体积，这里先清掉
        deleteTree(dir);
        if (!dir.exists() && !dir.mkdirs()) {
            call.reject("无法创建缓存目录");
            return;
        }

        JSArray files = new JSArray();
        for (Uri uri : uris) {
            try {
                // 同一份文件下次再选时还能直接读
                getContext().getContentResolver().takePersistableUriPermission(
                        uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {
                // 部分 provider 不支持持久授权，本次仍可读
            }

            String name = queryName(uri);
            File target = new File(dir, System.currentTimeMillis() + "-" + name);
            try (InputStream in = getContext().getContentResolver().openInputStream(uri);
                 OutputStream out = new FileOutputStream(target)) {
                if (in == null) continue;
                copy(in, out);
            } catch (Exception err) {
                target.delete();
                continue;
            }

            JSObject item = new JSObject();
            item.put("name", name);
            item.put("path", target.getAbsolutePath());
            item.put("size", target.length());
            item.put("type", getContext().getContentResolver().getType(uri));
            files.put(item);
        }

        JSObject ret = new JSObject();
        ret.put("files", files);
        call.resolve(ret);
    }

    /* ==================== 选目录 ==================== */

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        // 让选择器直接落在上次/常用的位置，少点几层
        String initial = call.getString("initialUri");
        if (initial != null && !initial.isEmpty()) {
            try {
                intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, Uri.parse(initial));
            } catch (Exception ignored) {
                // 部分系统不认这个 extra
            }
        }
        startActivityForResult(call, intent, "folderResult");
    }

    @ActivityCallback
    private void folderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK) {
            call.reject("cancelled");
            return;
        }
        Intent data = result.getData();
        Uri tree = data != null ? data.getData() : null;
        if (tree == null) {
            call.reject("没有拿到目录");
            return;
        }

        try {
            getContext().getContentResolver().takePersistableUriPermission(
                    tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignored) {
            // 拿不到持久授权也能读完本次
        }

        final String treeId;
        try {
            treeId = DocumentsContract.getTreeDocumentId(tree);
        } catch (Exception err) {
            call.reject("无法解析所选目录");
            return;
        }

        getBridge().execute(() -> {
            JSArray files = new JSArray();
            int[] count = new int[]{0};
            boolean[] truncated = new boolean[]{false};
            try {
                walk(tree, treeId, "", files, count, truncated, 0);
            } catch (Exception err) {
                call.reject("遍历目录失败：" + err.getMessage());
                return;
            }
            JSObject ret = new JSObject();
            ret.put("treeUri", tree.toString());
            ret.put("files", files);
            ret.put("truncated", truncated[0]);
            call.resolve(ret);
        });
    }

    /** 递归找书：只看文件名后缀，不碰图片目录本身 */
    private void walk(Uri tree, String docId, String prefix, JSArray out,
                      int[] count, boolean[] truncated, int depth) {
        if (depth > MAX_DEPTH || truncated[0]) return;

        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
        String[] proj = {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        };

        try (Cursor c = getContext().getContentResolver().query(children, proj, null, null, null)) {
            if (c == null) return;
            while (c.moveToNext()) {
                if (count[0] >= MAX_FILES) {
                    truncated[0] = true;
                    return;
                }
                String id = c.getString(0);
                String name = c.getString(1);
                String mime = c.getString(2);
                long size = c.isNull(3) ? 0 : c.getLong(3);
                long last = c.isNull(4) ? 0 : c.getLong(4);
                if (id == null || name == null || name.isEmpty()) continue;
                if (name.startsWith(".") || name.equals("Thumbs.db")) continue;

                String rel = prefix.isEmpty() ? name : prefix + "/" + name;

                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    if (name.equals("__MACOSX") || name.equals("node_modules")) continue;
                    walk(tree, id, rel, out, count, truncated, depth + 1);
                    continue;
                }
                if (!hasExt(name, BOOK_EXT)) continue;

                JSObject item = new JSObject();
                item.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                item.put("name", name);
                item.put("relPath", rel);
                item.put("size", size);
                item.put("lastModified", last);
                out.put(item);
                count[0]++;

                if (count[0] % 25 == 0) {
                    JSObject p = new JSObject();
                    p.put("count", count[0]);
                    p.put("name", name);
                    notifyListeners("enumProgress", p);
                }
            }
        } catch (Exception err) {
            // 单个目录读不到就跳过，别让整次导入失败
            JSObject p = new JSObject();
            p.put("skipped", prefix.isEmpty() ? "/" : prefix);
            notifyListeners("enumSkip", p);
        }
    }

    /* ==================== 落盘 ==================== */

    /**
     * 把一个 content:// 直接写进私有书库
     * 返回 { path, size, pages, coverPath, ext }
     */
    @PluginMethod
    public void stage(PluginCall call) {
        String uriStr = call.getString("uri");
        String id = call.getString("id");
        String name = call.getString("name");
        if (uriStr == null || id == null) {
            call.reject("缺少参数");
            return;
        }

        getBridge().execute(() -> {
            File target = null;
            try {
                String ext = extOf(name != null ? name : uriStr);
                File books = new File(getContext().getFilesDir(), "books");
                if (!books.exists() && !books.mkdirs()) throw new IOException("无法创建书库目录");

                String safeId = id.replaceAll("[^\\w.-]", "_");
                String fileName = ext.isEmpty() ? safeId + ".bin" : safeId + "." + ext;
                target = new File(books, fileName);

                long copied = 0;
                try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uriStr));
                     OutputStream out = new FileOutputStream(target)) {
                    if (in == null) throw new IOException("无法读取所选文件");
                    copied = copy(in, out);
                } catch (Exception err) {
                    target.delete();
                    throw err;
                }

                int pages = 0;
                String coverPath = null;
                if (isZip(ext)) {
                    Object[] info = inspectZip(target, safeId);
                    pages = (Integer) info[0];
                    coverPath = (String) info[1];
                }

                JSObject o = new JSObject();
                o.put("path", "books/" + fileName);
                o.put("absPath", target.getAbsolutePath());
                o.put("size", copied);
                o.put("ext", ext);
                o.put("pages", pages);
                o.put("coverPath", coverPath);
                call.resolve(o);
            } catch (Exception err) {
                if (target != null) target.delete();
                String msg = err.getMessage();
                call.reject(msg == null || msg.isEmpty() ? "写入失败" : msg);
            }
        });
    }

    /**
     * 只读 ZIP 中央目录：数图片条目 + 把第一张图抽到 cache/covers
     * 60MB 的包通常 10–30ms，不解压正文
     */
    private Object[] inspectZip(File file, String id) {
        int pages = 0;
        ZipEntry first = null;
        String coverPath = null;

        try (ZipFile zf = new ZipFile(file)) {
            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                if (e.isDirectory()) continue;
                if (!isComicPage(e.getName())) continue;
                pages++;
                if (first == null) first = e;
            }
            if (first != null) {
                File dir = new File(getContext().getCacheDir(), "covers");
                if (dir.exists() || dir.mkdirs()) {
                    String ext = extOf(first.getName());
                    File out = new File(dir, id + "." + (ext.isEmpty() ? "jpg" : ext));
                    try (InputStream in = zf.getInputStream(first);
                         OutputStream os = new FileOutputStream(out)) {
                        copy(in, os);
                    }
                    coverPath = out.getAbsolutePath();
                }
            }
        } catch (Exception ignored) {
            // 不是合法 ZIP（比如误命名的文件）：页数留 0，交给 JS 报错
        }
        return new Object[]{pages, coverPath};
    }

    /* ==================== 缓存清理 ==================== */

    /** 清掉选文件与封面留下的临时副本 */
    @PluginMethod
    public void clearCache(PluginCall call) {
        getBridge().execute(() -> {
            long freed = deleteTree(new File(getContext().getCacheDir(), "picked"));
            freed += deleteTree(new File(getContext().getCacheDir(), "covers"));
            JSObject o = new JSObject();
            o.put("freed", freed);
            call.resolve(o);
        });
    }

    /** 只清封面临时文件（批量导入结束后调用） */
    @PluginMethod
    public void clearCovers(PluginCall call) {
        getBridge().execute(() -> {
            long freed = deleteTree(new File(getContext().getCacheDir(), "covers"));
            JSObject o = new JSObject();
            o.put("freed", freed);
            call.resolve(o);
        });
    }

    /* ==================== 工具 ==================== */

    private static long copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[256 * 1024];
        long total = 0;
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            total += n;
        }
        return total;
    }

    private static long deleteTree(File f) {
        if (f == null || !f.exists()) return 0;
        long freed = 0;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) {
                for (File k : kids) freed += deleteTree(k);
            }
            f.delete();
            return freed;
        }
        freed = f.length();
        f.delete();
        return freed;
    }

    private static String extOf(String name) {
        if (name == null) return "";
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) return "";
        String ext = name.substring(dot + 1).toLowerCase();
        return ext.matches("[a-z0-9]{1,5}") ? ext : "";
    }

    private static boolean hasExt(String name, String[] pool) {
        String ext = extOf(name);
        for (String e : pool) if (e.equals(ext)) return true;
        return false;
    }

    private static boolean isZip(String ext) {
        return "cbz".equals(ext) || "zip".equals(ext) || "epub".equals(ext);
    }

    /** 与 js/import.js 的 comicEntries 保持同一套过滤规则，页数才对得上 */
    private static boolean isComicPage(String path) {
        if (!hasExt(path, IMG_EXT)) return false;
        if (path.startsWith("__MACOSX/")) return false;
        String[] segs = path.split("/");
        for (String s : segs) {
            if (s.isEmpty()) continue;
            if (s.startsWith(".")) return false;
            if (s.toLowerCase().matches("thumb|thumbs|thumbnail|thumbnails")) return false;
        }
        return true;
    }

    private String queryName(Uri uri) {
        String name = "book";
        try (Cursor c = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) {
                    String v = c.getString(idx);
                    if (v != null && !v.isEmpty()) name = v;
                }
            }
        } catch (Exception ignored) {
            // 拿不到就用默认名
        }
        return name.replaceAll("[\\\\/:*?\"<>|]", "_");
    }
}
