package io.github.szymonbite.earworm;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import androidx.browser.customtabs.CustomTabsIntent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;

/**
 * Google sign-in through the phone's browser (a Custom Tab). Unlike Google Play
 * services' sign-in, Google's web sign-in asks which YouTube profile (Brand
 * Account) to use. Google sends the browser back to http://127.0.0.1:PORT/ with
 * a one-time code, which this plugin catches with a tiny local server. That's
 * the "loopback" redirect Google supports for "Desktop app" OAuth clients.
 * The JavaScript side is src/local/native.ts.
 */
@CapacitorPlugin(name = "BrowserSignIn")
public class BrowserSignInPlugin extends Plugin {

    private static final int TIMEOUT_MS = 10 * 60 * 1000;
    /** How long to wait, after you come back to the app, for a redirect that's still on its way. */
    private static final int GRACE_MS = 1500;

    private ServerSocket server;
    private PluginCall waiting;

    /** Starts listening, and resolves with the redirect URI to put in Google's sign-in URL. */
    @PluginMethod
    public void start(PluginCall call) {
        closeServer();
        try {
            server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
            JSObject response = new JSObject();
            response.put("redirectUri", "http://127.0.0.1:" + server.getLocalPort() + "/");
            call.resolve(response);
        } catch (IOException e) {
            call.reject(e.getMessage(), "google_error", e);
        }
    }

    /** Opens the sign-in page and resolves with { code, state, error } from Google's redirect. */
    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        ServerSocket socket = server;
        if (url == null || socket == null) {
            call.reject("Call start() first", "google_error");
            return;
        }
        synchronized (this) {
            if (waiting != null) waiting.reject("Replaced by a newer sign-in", "cancelled");
            waiting = call;
        }
        new Thread(() -> listen(socket, call), "earworm-sign-in").start();
        getActivity().runOnUiThread(() -> {
            Uri uri = Uri.parse(url);
            try {
                new CustomTabsIntent.Builder().build().launchUrl(getActivity(), uri);
            } catch (ActivityNotFoundException e) {
                getActivity().startActivity(new Intent(Intent.ACTION_VIEW, uri));
            }
        });
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        PluginCall call = waiting;
        if (call == null) return;
        // Back in the app without Google having redirected: the sign-in page was closed.
        new Handler(Looper.getMainLooper()).postDelayed(
            () -> {
                if (waiting == call) closeServer();
            },
            GRACE_MS
        );
    }

    private void listen(ServerSocket socket, PluginCall call) {
        try {
            socket.setSoTimeout(TIMEOUT_MS);
            while (true) {
                try (Socket client = socket.accept()) {
                    BufferedReader in = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
                    String requestLine = in.readLine();
                    if (requestLine == null) continue;
                    String line;
                    while ((line = in.readLine()) != null && !line.isEmpty()) {
                        // Skip the request headers.
                    }
                    String[] parts = requestLine.split(" ");
                    Uri uri = Uri.parse("http://127.0.0.1" + (parts.length > 1 ? parts[1] : "/"));
                    String code = uri.getQueryParameter("code");
                    String error = uri.getQueryParameter("error");
                    if (code == null && error == null) {
                        respond(client, "404 Not Found", "Not found");
                        continue;
                    }
                    respond(client, "200 OK", page(error == null));
                    JSObject result = new JSObject();
                    result.put("code", code);
                    result.put("state", uri.getQueryParameter("state"));
                    result.put("error", error);
                    settle(call, result, null);
                    return;
                }
            }
        } catch (SocketTimeoutException e) {
            settle(call, null, "Signing in took too long");
        } catch (IOException e) {
            settle(call, null, "The sign-in page was closed");
        } finally {
            try {
                socket.close();
            } catch (IOException ignored) {}
        }
    }

    private synchronized void settle(PluginCall call, JSObject result, String failure) {
        if (waiting != call) return;
        waiting = null;
        if (result != null) call.resolve(result);
        else call.reject(failure, "cancelled");
    }

    private synchronized void closeServer() {
        if (server == null) return;
        try {
            server.close();
        } catch (IOException ignored) {}
        server = null;
    }

    private static void respond(Socket client, String status, String html) throws IOException {
        byte[] body = html.getBytes(StandardCharsets.UTF_8);
        OutputStream out = client.getOutputStream();
        String head =
            "HTTP/1.1 " +
            status +
            "\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " +
            body.length +
            "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    /** The page Google's redirect lands on, with a button back to the app. */
    private String page(boolean signedIn) {
        String pkg = getContext().getPackageName();
        String back = "intent://signed-in#Intent;scheme=" + pkg + ";package=" + pkg + ";end";
        return (
            "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\">" +
            "<title>Earworm</title></head>" +
            "<body style=\"margin:0;padding:64px 24px;background:#0b0b10;color:#fff;font-family:system-ui,sans-serif;text-align:center\">" +
            "<h1 style=\"font-size:24px\">" +
            (signedIn ? "✓ Signed in" : "Sign-in cancelled") +
            "</h1><p style=\"color:#a5a5b5\">Go back to Earworm to finish.</p>" +
            "<p><a href=\"" +
            back +
            "\" style=\"display:inline-block;margin-top:16px;padding:14px 24px;border-radius:999px;" +
            "background:linear-gradient(135deg,#ff3d71,#7c5cff);color:#fff;font-weight:700;text-decoration:none\">Return to Earworm</a></p>" +
            "</body></html>"
        );
    }
}
