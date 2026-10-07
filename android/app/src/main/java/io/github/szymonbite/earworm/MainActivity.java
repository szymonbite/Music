package io.github.szymonbite.earworm;

import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-specific plugins have to be registered before the bridge starts.
        registerPlugin(GoogleAuthPlugin.class);
        super.onCreate(savedInstanceState);

        // Capacitor opens links to other sites in their own apps (e.g. "Open in YouTube Music").
        // Only do that when the whole page navigates: loads inside frames, like YouTube's
        // embedded player, have to stay in the app.
        bridge.setWebViewClient(
            new BridgeWebViewClient(bridge) {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    return request.isForMainFrame() && super.shouldOverrideUrlLoading(view, request);
                }
            }
        );
    }
}
