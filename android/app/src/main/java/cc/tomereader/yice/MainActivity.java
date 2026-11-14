package cc.tomereader.yice;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

import java.util.Locale;

import com.getcapacitor.BridgeActivity;

/**
 * 平板壳：
 * 1. 关掉 WebView 自带的缩放 / 字号跟随，避免 CSS 分页算错
 * 2. 边缘到边缘 + 把系统栏 inset 推给 JS（刘海、手势条）
 * 3. 注册 SAF 文件选择插件
 *
 * 返回键统一交给 @capacitor/app 的 backButton 事件（JS 侧 native.js 已接管），
 * 阅读器打开时先关面板再退阅读器，书架页才退出。
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 先注册自定义插件，再交给 Bridge 初始化
        registerPlugin(BookPickerPlugin.class);

        // 让 WebView 铺到系统栏下面，由 CSS env() / 推送的 inset 负责留白
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        super.onCreate(savedInstanceState);

        setupWebView();
        applyInsets();
    }

    private void setupWebView() {
        WebView webView = getBridge().getWebView();
        if (webView == null) return;

        WebSettings s = webView.getSettings();
        s.setTextZoom(100);                    // 不跟随系统字号
        s.setSupportZoom(false);               // 缩放交给阅读器自己处理
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);

        webView.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
    }

    private void applyInsets() {
        WebView webView = getBridge().getWebView();
        if (webView == null) return;

        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
            Insets cut = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            float density = getResources().getDisplayMetrics().density;
            if (density <= 0f) density = 1f;

            // WebView 里的 CSS px 是 dp，所以要把物理 px 换成 dp
            pushInsets(cut.left / density, cut.top / density, cut.right / density, cut.bottom / density);
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(webView);
    }

    private void pushInsets(float left, float top, float right, float bottom) {
        String js = String.format(Locale.US,
                "window.__setNativeInsets && window.__setNativeInsets({left:%.2f,top:%.2f,right:%.2f,bottom:%.2f});",
                left, top, right, bottom);
        WebView webView = getBridge().getWebView();
        if (webView == null) return;
        webView.post(() -> webView.evaluateJavascript(js, null));
    }
}
