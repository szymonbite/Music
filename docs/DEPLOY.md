# Putting Earworm online (Fly.io)

This guide gets Earworm running at a public `https://…fly.dev` address that you and your friends can open on your phones. It's sized for a small group (up to about 30 people) and costs a couple of dollars a month.

**What you'll set up**

- An app on **[Fly.io](https://fly.io)**: one small machine that sleeps when nobody's using it, plus a 1 GB disk for the database. That's roughly **$2–3 per month**. Fly bills by usage, so check their [pricing page](https://fly.io/docs/about/pricing/).
- A **Google Cloud** project for "Connect YouTube Music" and the YouTube API key. Free.
- Optionally a free **Last.fm** API key for better "similar artists".

Allow about 20–30 minutes.

## 1. Install the Fly.io command line tool and sign in

```bash
# macOS
brew install flyctl
# Linux / WSL
curl -L https://fly.io/install.sh | sh
# Windows (PowerShell)
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"

fly auth signup   # or: fly auth login
```

Fly asks for a payment card when you sign up.

## 2. Create the app and its disk

Pick an app name that's unique on Fly (for example `earworm-szymon`) and a region near you. Run `fly platform regions` to list regions, e.g. `ams` Amsterdam, `waw` Warsaw, `lhr` London.

```bash
fly apps create earworm-szymon
fly volumes create earworm_data --size 1 --region waw -a earworm-szymon
```

Then open `fly.toml` and set the same two values:

```toml
app = "earworm-szymon"
primary_region = "waw"
```

Your app's address will be `https://earworm-szymon.fly.dev` (`<app-name>.fly.dev` below). Earworm keeps everything in one SQLite file, so the app must stay on **one machine**. If Fly ever creates two, run `fly scale count 1`.

## 3. Set up Google (Connect YouTube Music)

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create a project.
2. Go to **APIs & Services → Library**, search for **YouTube Data API v3**, and enable it.
3. Go to **APIs & Services → OAuth consent screen**:
   - Choose **External**, then fill in the app name, your email and the developer contact.
   - Add these scopes: `openid`, `…/auth/userinfo.email`, `…/auth/userinfo.profile` and `…/auth/youtube`.
   - Under **Test users**, add your own Google account and each friend's (up to 100).
4. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized redirect URI: `https://<app-name>.fly.dev/api/auth/google/callback`
   - If you also run it locally, add `http://localhost:3000/api/auth/google/callback` too.
5. Still on **Credentials**, choose **Create credentials → API key**. Then **Edit API key → API restrictions → YouTube Data API v3**.

> **The 7-day catch.** While the consent screen is in **Testing**, Google expires each person's connection after 7 days. Earworm keeps all their likes, saves and comments, and shows a **Reconnect** banner. One tap fixes it.
>
> To avoid the weekly reconnect, click **Publish app** on the consent screen. For a small group you don't need Google's verification review. People then see a "Google hasn't verified this app" warning when connecting, and continue via **Advanced → Go to Earworm**. Unverified apps are limited to 100 users, which is plenty here.

## 4. Optional: Last.fm key for smarter discovery

Without any key, Earworm finds similar artists through Deezer's public API. Last.fm's data is usually better:

1. Create an API account at [last.fm/api/account/create](https://www.last.fm/api/account/create). Any app name works and the callback URL can be blank.
2. Copy the **API key**. You don't need the shared secret.

## 5. Add your secrets

```bash
fly secrets set \
  APP_URL=https://<app-name>.fly.dev \
  GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com \
  GOOGLE_CLIENT_SECRET=GOCSPX-... \
  YOUTUBE_API_KEY=AIza... \
  LASTFM_API_KEY=...            # optional
```

The other settings (port, database path, HTTPS cookies, proxy trust) are already in `fly.toml`.

## 6. Deploy

```bash
fly deploy
```

Open `https://<app-name>.fly.dev` and send the link to your friends. To update later, pull the latest code and run `fly deploy` again. Your data stays on the disk.

## Everyday operations

| Task | Command |
| --- | --- |
| See logs | `fly logs` |
| Check it's healthy | `fly status` |
| Restart | `fly apps restart` |
| Back up the database | `fly ssh sftp get /data/earworm.db ./earworm-backup.db` |
| Change a setting | `fly secrets set NAME=value` (restarts the app) |

The machine sleeps after a few idle minutes and wakes on the next visit. The first load after a nap takes a second or two.

### Keeping within YouTube's free quota

Each Google project gets 10,000 YouTube API units a day:

- Every synced like, dislike or save costs 50.
- Each YouTube search costs 100.
- Discovery searches for new similar artists are capped by `YOUTUBE_DAILY_SEARCH_BUDGET` (default 30, so at most 3,000 units).

For around 30 people that's usually fine. If you hit the limit, sync and search pause until midnight Pacific time, and everything else keeps working.

## Running the image somewhere else

The `Dockerfile` works on any host that runs containers. Give it a persistent volume at `/data` and set the same environment variables:

```bash
docker build -t earworm .
docker run -d -p 8080:8080 -v earworm-data:/data --env-file .env earworm
```

Put it behind HTTPS and set `APP_URL`, `COOKIE_SECURE=true` and `TRUST_PROXY=1`. Railway and Render (paid plans with a disk) work the same way.
