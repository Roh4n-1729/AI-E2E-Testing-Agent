# Deploying a working instance (Render)

A live copy of the UI that anyone with the access code can use: start runs, watch the browser, read the
results. It runs in a Docker container with Chromium, the three demo apps next to it (Sauce Demo, the buggy
shop, TodoMVC) and the runs you bake in. Render's 1 CPU / 2 GB instance is the smallest that fits Chromium
plus the agent; it costs $25 a month, billed by the second, so a few days cost a few dollars.

## What protects it

The instance launches browsers and AI calls on your account, so a deployed copy is locked down
(`src/server/access.js`, tested in `tests/access.test.js`):

| Guard                              | What it does                                                                                                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access code (`AIE2E_ACCESS_CODE`)  | Every API call and run file needs it; a cookie keeps a visitor in for 12 hours. 10 wrong codes lock that visitor out for 10 minutes. Without a code the server will not listen beyond localhost.                |
| Host names (`AIE2E_ALLOWED_HOSTS`) | Only your `onrender.com` name (filled in from Render's `RENDER_EXTERNAL_HOSTNAME`).                                                                                                                             |
| Targets                            | Nothing on the server's own machine or network (localhost, private ranges, cloud metadata), checked after DNS too. The demo apps are the exception (`AIE2E_ALLOWED_TARGETS`). Any public web app can be tested. |
| Login                              | The account in `AIE2E_USERNAME` / `AIE2E_PASSWORD` is only typed into a login page on a listed app, never one a visitor chooses, including through a saved suite.                                               |
| Size                               | At most 4 planned tests (`AIE2E_SHARED_MAX_TESTS`), one test at a time (`AIE2E_SHARED_CONCURRENCY`), one run at a time, never headed.                                                                           |
| Paths                              | Health and runs do not show server paths.                                                                                                                                                                       |

Set a monthly spend limit on your Anthropic account as well: the code limits who, not how much.

## 1. Bake in the runs to show

On your laptop, from the repo:

```powershell
npm run deploy:seed -- --runs 20261031031448-f7d8,20261030111859-a09b,20261030105506-e080,20261030105946-f2c7,20261031042745-a821,20261031042912-e355
```

This copies those runs, plus every recording, saved plan, suite and approved screenshot, into
`deploy/seed`. It prints the size; keep it under about 50 MB. Look at what is in it: it is committed and shown
to anyone with the code (URLs, usernames and screenshots, never passwords).

```powershell
git add deploy/seed
git commit -m "Bake demo runs into the deployed image"
git push
```

## 2. Create the service

In the Render dashboard: **New → Web Service → Build and deploy from a Git repository**, pick
`Roh4n-1729/AI-E2E-Testing-Agent`, then:

| Setting           | Value                                 |
| ----------------- | ------------------------------------- |
| Branch            | `plan-v2` (or `main` after the merge) |
| Language          | Docker (found from the `Dockerfile`)  |
| Instance type     | 2 GB RAM, 1 CPU                       |
| Health check path | `/healthz` (Advanced)                 |

Environment variables (**Environment** tab; mark the key and the code as secret):

| Name                | Value                                               |
| ------------------- | --------------------------------------------------- |
| `ANTHROPIC_API_KEY` | your key                                            |
| `AIE2E_ACCESS_CODE` | a long code you will share, e.g. three random words |
| `AIE2E_PRESET`      | `balanced` (or `best` for the interview window)     |
| `AIE2E_USERNAME`    | `standard_user`                                     |
| `AIE2E_PASSWORD`    | `secret_sauce` (Sauce Demo's public demo password)  |

Deploy. The first build takes about 5 to 10 minutes (Chromium and its system libraries). When the log shows
`AI E2E Agent UI: http://localhost:10000`, open `https://<your-service>.onrender.com`, enter the code, and
check: the six runs are under **Runs**, **New run** shows the demo apps as buttons, and **Test suites →
swag-labs → Run** replays 6 tests for free.

## 3. After the interview

Suspend or delete the service in Render (**Settings**), so billing stops. Rotate the API key if you shared
the code widely.

## Good to know

- Runs made on the instance disappear when it restarts or redeploys (no paid disk); the baked-in runs come
  back each time.
- Everyone shares one queue: a second run waits for the first ("A run is already in progress").
- The app's own `.env` is not used; Render's environment variables replace it.

## If something goes wrong

| Problem                                                      | Do this                                                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Build fails at `playwright install`                          | Retry the deploy; it downloads Chromium and can time out.                                           |
| "Only local access is allowed"                               | The host name is not allowed: set `AIE2E_ALLOWED_HOSTS` to your `onrender.com` name.                |
| The code page comes back after unlocking                     | The cookie needs HTTPS: open the `https://` address, not `http://`.                                 |
| "…does not open addresses on the owner's machine or network" | Working as intended for localhost and private addresses; use a demo app button or a public URL.     |
| Tests time out on a busy instance                            | Keep `AIE2E_SHARED_CONCURRENCY` at 1 (the default): one browser already keeps the 1 CPU busy.       |
| Port errors                                                  | Render sets `PORT`; the image defaults to 10000. Do not set `AIE2E_HOST` to anything but `0.0.0.0`. |
