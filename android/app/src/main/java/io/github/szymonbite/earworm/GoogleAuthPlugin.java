package io.github.szymonbite.earworm;

import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.common.api.Scope;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/**
 * "Connect YouTube Music" in the Android app. Google doesn't allow its sign-in
 * pages inside an app's web view, so the account picker and consent screen come
 * from Google Play services, which hands back an access token for the YouTube
 * Data API. The JavaScript side is src/local/native.ts.
 */
@CapacitorPlugin(name = "GoogleAuth")
public class GoogleAuthPlugin extends Plugin {

    private static final List<Scope> SCOPES = Arrays.asList(
        new Scope("openid"),
        new Scope("email"),
        new Scope("profile"),
        new Scope("https://www.googleapis.com/auth/youtube")
    );

    /** GoogleSignInStatusCodes.SIGN_IN_CANCELLED, which some Play services versions still use. */
    private static final int SIGN_IN_CANCELLED = 12501;

    private ActivityResultLauncher<IntentSenderRequest> consentLauncher;
    private PluginCall pendingCall;

    @Override
    public void load() {
        consentLauncher = getActivity().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(),
            this::onConsentResult
        );
    }

    /**
     * Resolves with { accessToken, grantedScopes }. With interactive: false it never shows
     * anything, and rejects with code "consent_required" if the listener has to sign in again.
     * Other failures reject with code "cancelled" or "google_error" and data { status }, Google's
     * status code (10 means Google doesn't recognise the app: see appIdentity()).
     */
    @PluginMethod
    public void authorize(PluginCall call) {
        boolean interactive = Boolean.TRUE.equals(call.getBoolean("interactive", true));
        AuthorizationRequest request = AuthorizationRequest.builder().setRequestedScopes(SCOPES).build();
        Identity.getAuthorizationClient(getActivity())
            .authorize(request)
            .addOnSuccessListener(result -> {
                if (!result.hasResolution()) {
                    resolveWith(call, result);
                    return;
                }
                PendingIntent consent = result.getPendingIntent();
                if (!interactive || consent == null) {
                    call.reject("Google needs you to sign in again", "consent_required");
                    return;
                }
                if (pendingCall != null) pendingCall.reject("Replaced by a newer sign-in", "cancelled");
                pendingCall = call;
                consentLauncher.launch(new IntentSenderRequest.Builder(consent.getIntentSender()).build());
            })
            .addOnFailureListener(e -> rejectWith(call, e));
    }

    /** The package name and signing certificate Google Cloud needs to recognise this app. */
    @PluginMethod
    public void appIdentity(PluginCall call) {
        try {
            JSObject response = new JSObject();
            response.put("packageName", getContext().getPackageName());
            response.put("sha1", signingCertificateSha1());
            call.resolve(response);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    private void onConsentResult(ActivityResult activityResult) {
        PluginCall call = pendingCall;
        pendingCall = null;
        if (call == null) return;
        // Google reports failures (not only a real "back") as a cancelled result, with the
        // actual reason in the result intent, so always read it.
        Intent data = activityResult.getData();
        if (data == null) {
            JSObject details = new JSObject();
            details.put("status", CommonStatusCodes.CANCELED);
            call.reject("Google closed the sign-in without an answer", "cancelled", null, details);
            return;
        }
        try {
            resolveWith(call, Identity.getAuthorizationClient(getActivity()).getAuthorizationResultFromIntent(data));
        } catch (ApiException e) {
            rejectWith(call, e);
        }
    }

    private void resolveWith(PluginCall call, AuthorizationResult result) {
        String token = result.getAccessToken();
        if (token == null) {
            call.reject("Google didn't return an access token", "google_error");
            return;
        }
        JSArray scopes = new JSArray();
        for (String scope : result.getGrantedScopes()) scopes.put(scope);
        JSObject response = new JSObject();
        response.put("accessToken", token);
        response.put("grantedScopes", scopes);
        call.resolve(response);
    }

    private void rejectWith(PluginCall call, Exception e) {
        int status = e instanceof ApiException ? ((ApiException) e).getStatusCode() : CommonStatusCodes.ERROR;
        boolean cancelled = status == CommonStatusCodes.CANCELED || status == SIGN_IN_CANCELLED;
        JSObject details = new JSObject();
        details.put("status", status);
        call.reject(e.getMessage(), cancelled ? "cancelled" : "google_error", e, details);
    }

    @SuppressWarnings("deprecation")
    private String signingCertificateSha1() throws Exception {
        PackageManager pm = getContext().getPackageManager();
        String pkg = getContext().getPackageName();
        Signature[] signatures;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageInfo info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES);
            signatures = info.signingInfo.getApkContentsSigners();
        } else {
            signatures = pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES).signatures;
        }
        byte[] digest = MessageDigest.getInstance("SHA-1").digest(signatures[0].toByteArray());
        StringBuilder hex = new StringBuilder();
        for (byte b : digest) {
            if (hex.length() > 0) hex.append(':');
            hex.append(String.format(Locale.US, "%02X", b));
        }
        return hex.toString();
    }
}
