package io.github.szymonbite.earworm;

import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * Installs a newer Earworm: downloads the APK, checks it against the SHA-256
 * published with it, then opens Android's installer. Android shows the
 * install screen (and, the first time, asks to allow Earworm to install
 * apps); it only accepts an APK signed with the same key as this one.
 * The JavaScript side is src/local/updater.ts.
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

    @PluginMethod
    public void install(PluginCall call) {
        String url = call.getString("url");
        String sha256 = call.getString("sha256");
        if (url == null || !url.startsWith("https://") || sha256 == null) {
            call.reject("Missing or insecure update address", "update_failed");
            return;
        }
        new Thread(
            () -> {
                try {
                    File dir = new File(getContext().getCacheDir(), "updates");
                    if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Couldn't make room for the download");
                    File apk = new File(dir, "earworm-update.apk");
                    String actual = download(url, apk);
                    if (!actual.equalsIgnoreCase(sha256)) {
                        apk.delete();
                        throw new IOException("The download was damaged. Please try again.");
                    }
                    Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                    Intent intent = new Intent(Intent.ACTION_VIEW)
                        .setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    getActivity().runOnUiThread(() -> {
                        getActivity().startActivity(intent);
                        call.resolve();
                    });
                } catch (Exception e) {
                    call.reject(e.getMessage() != null ? e.getMessage() : "Downloading the update failed", "update_failed", e);
                }
            },
            "earworm-update"
        ).start();
    }

    /** Downloads url into file (following GitHub's redirect to its download servers) and returns its SHA-256. */
    private static String download(String url, File file) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setInstanceFollowRedirects(true);
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(60_000);
        try {
            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) throw new IOException("Downloading the update failed (" + status + ")");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(file)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    digest.update(buffer, 0, read);
                    out.write(buffer, 0, read);
                }
            }
            StringBuilder hex = new StringBuilder();
            for (byte b : digest.digest()) hex.append(String.format(Locale.US, "%02x", b));
            return hex.toString();
        } finally {
            connection.disconnect();
        }
    }
}
