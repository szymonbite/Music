# Earworm for Android

Earworm also comes as an Android app (an APK you install yourself). Everything runs **on your phone**: no server to host and nothing to pay. It's made for one listener, so the friends features (the Friends feed, People, followers) are only on the web version.

Your likes, saves, comments and favourites are stored on the phone. They survive app updates, and Android's automatic backup includes them.

## Install it

1. On your Android phone, open the [latest build](https://github.com/szymonbite/Music/releases/tag/android-latest) and tap **earworm.apk**.
2. Open the download. Android asks whether your browser may install apps. Allow it.
3. Google Play Protect may warn that it doesn't know this app, because it isn't from the Play Store. Choose **More details → Install anyway**.
4. Open **Earworm**.

To update, install the newest `earworm.apk` the same way. It installs over the old version and keeps your data.

A new build is made automatically whenever code is pushed to the repository ([GitHub Actions](../.github/workflows/android.yml)).

## Connect YouTube Music (one-time Google setup)

Earworm works without this, using its built-in catalogue. Connecting YouTube Music adds these:

- Import your liked songs and playlists.
- Search YouTube.
- Mirror your likes and saves to YouTube Music.
- Get fresh recommendations.

The app uses Android's own Google account picker. Google first needs to know the app exists, so do this once (about 10 minutes):

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a project or reuse the one from the web version. Under **APIs & Services → Library**, enable **YouTube Data API v3**.
2. Set up the **OAuth consent screen**. Google Cloud now calls this section **Google Auth Platform**, with pages named Branding, Audience, Data access and Clients.
   - Choose **External** (under **Audience**).
   - Add the scopes `openid`, `…/auth/userinfo.email`, `…/auth/userinfo.profile` and `…/auth/youtube` (under **Data access**).
   - Under **Audience → Test users**, add the Google account you'll use on the phone.
3. Go to **Clients** (or **Credentials → Create credentials → OAuth client ID**) and create a client:
   - Application type: **Android**
   - Package name: `io.github.szymonbite.earworm`
   - SHA-1 certificate fingerprint: `B2:B8:6F:86:67:9A:A1:3A:F1:9D:56:B5:9F:D4:AB:EB:DE:CD:DC:85`
4. In the app, open **Me → Connect YouTube Music**, pick your account and allow access.

That's all. There's no client secret, and nothing to type into the app. Google can take a few minutes to recognise a new client.

If connecting fails, the app explains why and shows the exact package name and SHA-1 the installed app has, so you can compare them with Google Cloud.

> **The 7-day catch** from the web version applies here too. While the consent screen is in **Testing**, Google may ask you to sign in again after a week. Earworm shows a **Reconnect** banner, and one tap fixes it. Clicking **Publish app** on the consent screen avoids it. For personal use you don't need Google's verification: you'll see a "Google hasn't verified this app" warning once and continue via **Advanced**.

### Using a YouTube profile that isn't your main one (Brand Account)

Android's own Google sign-in always connects your Google account's main YouTube profile, and never asks which one. If you switch between profiles in the YouTube app (**profile picture → Switch account**) and use one that isn't the main one, Earworm can sign in through your browser instead. There, Google asks which profile to use. This needs one more client in the same Google Cloud project:

1. Open **Google Auth Platform → Clients → Create client**.
2. Choose **Desktop app**, give it any name (e.g. `Earworm browser sign-in`) and click **Create**.
3. Click **Download JSON** right away. Google only shows the client secret once, when you create the client.
4. Get that file onto your phone. In Earworm, open **Me → YouTube Music → Use a different YouTube profile → Load the downloaded file**. You can also paste the client ID and secret into the two fields there.
5. Tap **Connect YouTube Music** (or **Switch YouTube profile** if you're already connected). Your browser opens Google's sign-in: pick your account, then your YouTube profile, then allow access. Tap **Return to Earworm** at the end.

From then on, connecting and reconnecting always go through the browser, and Earworm remembers your profile choice. **Stop using browser sign-in** on the Me tab switches back to Android's sign-in.

## What's different from the website

- **Just you.** There's no Friends tab, People page or followers. Comments work as notes to yourself.
- **Share** gives a YouTube Music link, since the app has no web address of its own.
- **Erase my data** (on the Me tab) replaces "Start over". It deletes everything on the phone. Anything already synced to YouTube Music stays there.
- **Searching YouTube and pasting links** need a connected YouTube Music account, because the app has no API key of its own. See [Optional keys](#optional-keys).
- **Similar artists** come from Deezer's public API.

## How it works

The app runs the same code as the web server: its routes, recommender and YouTube sync. The difference is where that code runs:

- **Backend:** it runs inside the app ([`src/local/`](../src/local)), with SQLite compiled to WebAssembly ([sql.js](https://sql.js.org)). The database is saved to the phone's storage about a second after each change, and right away when you leave the app.
- **App shell:** [Capacitor](https://capacitorjs.com) wraps the web app.
- **Network:** calls to YouTube, Google and Deezer go through Android's HTTP stack, so browser CORS rules don't get in the way.
- **Google sign-in** uses Google Play services ([`GoogleAuthPlugin.java`](../android/app/src/main/java/io/github/szymonbite/earworm/GoogleAuthPlugin.java)). Google blocks its web sign-in page inside apps.
- **Songs** play through YouTube's official player. The app identifies itself to YouTube as `https://io.github.szymonbite.earworm`, which YouTube requires for players inside apps.

## Signing key

Every build is signed with [`android/app/earworm.keystore`](../android/app/earworm.keystore) (password `earworm`). That keeps two things working:

- Updates install over each other.
- Google keeps recognising the app (the SHA-1 above).

Because this repository is public, anyone could sign an app with that key. So only install Earworm APKs from your own releases.

To switch to a private key:

1. Make a keystore:

   ```bash
   keytool -genkeypair -keystore my.keystore -alias earworm -keyalg RSA -keysize 2048 -validity 36500
   ```

2. Add these as repository secrets (**Settings → Secrets and variables → Actions**):
   - `ANDROID_KEYSTORE_BASE64`: the file, base64-encoded
   - `ANDROID_KEYSTORE_PASSWORD`
   - `ANDROID_KEY_ALIAS`
   - `ANDROID_KEY_PASSWORD`
3. Replace the SHA-1 in Google Cloud with your key's. Run `keytool -list -v -keystore my.keystore` to see it.

Android won't install an app signed with a different key over the old one. You'd have to uninstall first, which deletes the app's data. So switch keys before you start relying on the app.

## Optional keys

Two repository secrets get built into the app if you add them:

- `YOUTUBE_API_KEY`: lets search work before you connect an account.
- `LASTFM_API_KEY`: better similar artists.

The APK on the releases page is public, so anyone could pull these keys out of it. If you add a YouTube key, restrict it to **YouTube Data API v3** in Google Cloud.

## Build it yourself

You need Node.js 22.13+, JDK 21 and the Android SDK (Android Studio includes both):

```bash
npm ci
npm run android:sync          # builds the app's web bundle and copies it into android/
cd android && ./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk
```

Or run `npx cap open android` to open the project in Android Studio and run it on a phone connected by USB.

The app's web bundle also runs in a desktop browser for development and tests: `npm run build:app && npx vite preview --mode app`. Its browser tests are in [`e2e/android-app.spec.ts`](../e2e/android-app.spec.ts).

## Troubleshooting

| What you see | What to do |
| --- | --- |
| "Google doesn't recognise this app yet" | Check the Android OAuth client: the package name and SHA-1 must match exactly. It must be in the same Google Cloud project as the consent screen. Give Google a few minutes after creating it. |
| "Connecting YouTube Music was cancelled" when you didn't cancel | Google refused the app and reported it as a cancel. Usually your Google account isn't a test user (**Audience → Test users**), or there's no Android OAuth client with the package name and SHA-1 the app shows. |
| Connected, but to the wrong YouTube profile | Set up browser sign-in (see [Using a YouTube profile that isn't your main one](#using-a-youtube-profile-that-isnt-your-main-one-brand-account)), then tap **Switch YouTube profile**. |
| "Google didn't accept the sign-in" after picking your profile | The Desktop app client ID or secret is wrong, or the client is in a different Google Cloud project. Create a new Desktop app client and load its file again. |
| "Access blocked" or "app not verified" while connecting | Add your Google account under **Test users** on the consent screen, or publish the app. |
| Songs don't play (YouTube "error 153" or 152) | YouTube rejected the player. Update **Android System WebView** and **Chrome** from the Play Store, and make sure you're on the latest Earworm build. |
| A song says it can't be played here | Some videos aren't allowed in other apps. Earworm skips them automatically. |
