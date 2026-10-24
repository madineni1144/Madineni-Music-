package xyz.madineni.music.kiosk;

import android.app.Activity;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.net.Uri;

public class MainActivity extends Activity {
    private static final String HOME = "https://madinenimusic.madineni.xyz/";
    private WebView web;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().getDecorView().setSystemUiVisibility(5894 | 1024 | 512);
        DevicePolicyManager dpm = (DevicePolicyManager)getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName admin = new ComponentName(this, AdminReceiver.class);
        if (dpm.isDeviceOwnerApp(getPackageName())) {
            dpm.setLockTaskPackages(admin, new String[]{getPackageName()});
            IntentFilter filter = new IntentFilter(Intent.ACTION_MAIN);
            filter.addCategory(Intent.CATEGORY_HOME);
            filter.addCategory(Intent.CATEGORY_DEFAULT);
            dpm.addPersistentPreferredActivity(admin, filter, new ComponentName(this, MainActivity.class));
            if (dpm.isLockTaskPermitted(getPackageName())) startLockTask();
        }
        web = new WebView(this);
        web.setBackgroundColor(0xff0b0b0e);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setMediaPlaybackRequiresUserGesture(false);
        web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("https".equals(uri.getScheme()) && "madinenimusic.madineni.xyz".equals(uri.getHost())) return false;
                return true;
            }
        });
        setContentView(web);
        web.loadUrl(HOME);
    }
    @Override public void onBackPressed() { if (web != null && web.canGoBack()) web.goBack(); }
    @Override protected void onDestroy() { if (web != null) web.destroy(); super.onDestroy(); }
}
