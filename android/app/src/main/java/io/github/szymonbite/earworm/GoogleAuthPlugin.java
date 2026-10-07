package io.github.szymonbite.earworm;

import android.app.Activity;
import android.app.PendingIntent;
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
import com.google.android.gms.common.api.Scope;
import java.util.Arrays;
import java.util.List;

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
            .addOnFailureListener(e -> call.reject(e.getMessage(), "google_error", e));
    }

    private void onConsentResult(ActivityResult activityResult) {
        PluginCall call = pendingCall;
        pendingCall = null;
        if (call == null) return;
        if (activityResult.getResultCode() != Activity.RESULT_OK) {
            call.reject("Connecting YouTube Music was cancelled", "cancelled");
            return;
        }
        try {
            AuthorizationResult result = Identity.getAuthorizationClient(getActivity()).getAuthorizationResultFromIntent(
                activityResult.getData()
            );
            resolveWith(call, result);
        } catch (ApiException e) {
            call.reject(e.getMessage(), "google_error", e);
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
}
