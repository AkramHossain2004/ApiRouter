# Deploying ApiRouter on Render (A to Z guide)

This guide covers every step to connect your GitHub repo to Render and keep
ApiRouter online 24 hours a day on the free plan. Everything you need
(build/start commands, environment variables, keep-alive, UptimeRobot,
troubleshooting) is in one place.

> Never write a real API key or token in this file. Keep every secret only on
> Render's **Environment** page and never commit it to GitHub.

Prefer to let Claude do the deployment for you? See
[section 12](#12-deploy-with-claude-render-connector).

---

## 1. What you need

- A **GitHub account** (with access to this repo)
- A **Render account** (free): https://render.com
- **API keys** for the providers you want to use (Groq, Gemini, OpenRouter, etc.)
- (Optional) A free **UptimeRobot** account, to prevent sleeping

Node version: `>=20` (Render's default already satisfies this, nothing to do).

---

## 2. Connect GitHub to Render

1. Go to https://dashboard.render.com.
2. Click **Get Started / Sign in with GitHub**.
3. On the GitHub authorization page, click **Authorize Render**.
4. When asked for repository access, choose **Only select repositories**, select
   `ApiRouter`, then click **Install**.

If the repo is **private**, granting this access is **required**; otherwise
Render cannot clone it.

If the repo does not show up in the list later: GitHub → Settings →
Applications → Render → **Configure** → add `ApiRouter` under Repository access.

---

## 3. Create the Web Service

1. Render Dashboard → **New +** → **Web Service**.
2. **Build and deploy from a Git repository** → `ApiRouter` → **Connect**.
3. Use these settings:

| Field | Value |
|---|---|
| Name | `apirouter` (your URL is generated from this name) |
| Region | The one closest to you (for example Singapore) |
| Branch | `main` |
| Root Directory | (leave empty) |
| Runtime | Node |
| Build Command | `npm install --include=dev && npm run ui:build` |
| Start Command | `npm start` |
| Instance Type | **Free** |

**Why `--include=dev`?** `vite`, which builds the UI, is in `devDependencies`.
Without it `ui:build` fails and the Control Panel UI will not be available.

4. You can add **Environment Variables** right now (see step 4) or later.
5. Click **Create Web Service**.

The first build takes 3-5 minutes. You know it worked when the logs show:

```
Build successful
ApiRouter listening on http://0.0.0.0:10000
Keep-alive enabled: https://<your-service>.onrender.com/health every 10 min
Your service is live
```

---

## 4. Environment variables

Render Dashboard → your service → **Environment** → **Add Environment Variable**.

### Required

| Key | Value | Why |
|---|---|---|
| `HOST` | `0.0.0.0` | By default the server listens only on `127.0.0.1`, which Render cannot reach (the deploy fails with a port scan timeout). The server refuses to start on `0.0.0.0` unless `APIROUTER_API_KEYS` is also set |
| `APIROUTER_API_KEYS` | A long secret token you generate yourself | The gateway password. Without it, anyone who finds your URL can use it |

To generate a token (in a terminal):

```bash
echo "sk-router-$(openssl rand -hex 24)"
```

### Provider keys (the ones you use)

If you have more than one key for a provider, separate them with a **comma**.

```
GROQ_API_KEYS=gsk_xxx,gsk_yyy
GEMINI_API_KEYS=AIza...
OPENROUTER_API_KEYS=sk-or-...
MISTRAL_API_KEYS=...
CEREBRAS_API_KEYS=...
```

The full provider list and default models are in `.env.example`. To change models:

```
GROQ_MODELS=openai/gpt-oss-120b,qwen/qwen3.8-27b
```

If you use Cloudflare, you also need `CLOUDFLARE_ACCOUNT_IDS` alongside
`CLOUDFLARE_API_KEYS`.

### All other variables (models, base URLs): everything in `.env.example`

Keys alone are not enough. The repo has no `.env` file (it is in `.gitignore`),
so the rest of the `.env.example` variables must also be set on Render **as
environment variables**. Otherwise the models and base URLs will not be found
by the code.

**Easiest way: bulk paste**

1. Locally, copy `.env.example` to `.env` and fill in all your keys.
2. Render → your service → **Environment** → **Add from .env** (or **Edit as .env**).
3. Paste the contents of your `.env` → **Save**.
4. Remove empty values (`KEY=`) and `PORT` before pasting, and add `HOST=0.0.0.0` (it is commented out in `.env.example`).

These groups need to be present:

| Group | Variables | Purpose |
|---|---|---|
| Timeout / retry | `REQUEST_TIMEOUT_MS`, `STREAM_CONNECT_TIMEOUT_MS`, `RETRY_STATUS_CODES` | Request timeouts. `RETRY_STATUS_CODES` is now kept only for compatibility: on every error the next key/model is tried |
| Text keys | `*_API_KEYS` (+ `CLOUDFLARE_ACCOUNT_IDS`) | Provider keys |
| Text models | `*_MODELS` | Model list for each provider |
| Base URL | `*_BASE_URL` | Provider API root |
| AgentRouter | `AGENTROUTER_ORIGINATOR` (`AGENTROUTER_VERSION`, `AGENTROUTER_USER_AGENT` optional) | AgentRouter client identity |

To change models, edit only the `*_MODELS` of that provider, for example:

```
GROQ_MODELS=openai/gpt-oss-120b,qwen/qwen3.8-27b
```

**Variables you do not need to set on Render (leave them out)**

| Variable | Why |
|---|---|
| `PORT` | Render sets it itself (`10000`) |
| `FALLBACK_CHAIN_FILE`, `MANUAL_SELECTION_FILE`, `GATEWAY_STATE_FILE` | The code already defaults to `data/*.json`, which is the same. Without a persistent disk, `data/` is wiped on redeploy, and then the UI's Shutdown state is also lost (the backend starts again) |
| `CUSTOM_ENDPOINTS_GITHUB_REPO`, `CUSTOM_ENDPOINTS_GITHUB_TOKEN`, `CUSTOM_ENDPOINTS_SECRET` | **Set these so saved Custom Endpoints survive a redeploy.** Repo = `owner/name` (your ApiRouter repo works), Token = a GitHub fine-grained token (only that repo, Contents: Read and write), Secret = a passphrase of 12+ characters that you make up. Keys are encrypted and committed directly to the `main` branch (no PR needed), so every save triggers a Render redeploy. If you lose the secret, the saved data can no longer be read, so write it down somewhere safe |
| `KEEPALIVE_URL` | Set automatically on Render from `RENDER_EXTERNAL_URL` |
| `KEEPALIVE_INTERVAL_MS` | The default of 10 minutes is fine |

Empty values (for example `COHERE_MODELS=`) can stay empty, no need to set them.

Optional (has a default in the code, not in `.env.example`): `MAX_REQUEST_BODY_BYTES`.

### Do not set

- `PORT`: Render sets it for you (the code reads `PORT`).
- `RENDER_EXTERNAL_URL`: Render provides it automatically, and keep-alive uses it.

Saving a variable makes Render **redeploy automatically**.

---

## 5. Your links

After deploying, the URL appears at the top of the Render service page, for
example `https://apirouter-xxxx.onrender.com`.

| What | Where |
|---|---|
| Frontend UI (Control Panel) | `https://<your-service>.onrender.com/` |
| Base URL (give to clients) | `https://<your-service>.onrender.com/v1` |
| API Key (give to clients) | the `APIROUTER_API_KEYS` token from step 4 |
| Health check | `https://<your-service>.onrender.com/health` |

When the UI opens it asks for a token; enter the same `APIROUTER_API_KEYS` token.

### Test

```bash
curl https://<your-service>.onrender.com/health

curl https://<your-service>.onrender.com/v1/models

curl https://<your-service>.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"<MODEL_NAME>","messages":[{"role":"user","content":"hi"}]}'
```

Take `<MODEL_NAME>` from the `/v1/models` list.

In Cursor, Cline, Open WebUI, or any OpenAI-compatible app, just enter the
**Base URL** and the **API Key**.

---

## 6. Auto deploy from GitHub

**Auto-Deploy: On** is the default. That means every `git push` to the `main`
branch makes Render deploy the new version on its own.

```bash
git add .
git commit -m "your change"
git push origin main
```

To turn it off: service → **Settings** → **Build & Deploy** → **Auto-Deploy** → `No`.
Then deploy manually: service page → **Manual Deploy** → **Deploy latest commit**.

---

## 7. Staying awake on the free plan (online 24 hours)

A Render free service **sleeps after 15 minutes without an inbound request**,
and takes about 30-50 seconds to wake up when a request arrives.

### Layer 1: the repo's built-in keep-alive (automatic)

`src/keepalive.js` sends a request to its own public `/health` every **10 minutes**.
On Render this is **enabled automatically** (from `RENDER_EXTERNAL_URL`).

| Env | Purpose |
|---|---|
| `KEEPALIVE_URL` | Set a public URL on other hosts (not needed on Render) |
| `KEEPALIVE_INTERVAL_MS` | Interval (default `600000` = 10 min, minimum 60000) |
| `KEEPALIVE_URL=off` | Turn it off |

This is only a supplement; Render gives no guarantee.

### Layer 2: UptimeRobot (recommended backup)

1. Create a free account at https://uptimerobot.com.
2. Click **+ New monitor**.
3. Monitor Type: **HTTP(s)**
4. Friendly Name: `ApiRouter`
5. URL: `https://<your-service>.onrender.com/health`
6. Monitoring Interval: **5 minutes**
7. **Create Monitor**.

You also get an email alert when the service goes down.

`/health` is an open endpoint; it does not expose API keys or upstream
responses, so it is safe for a public monitor.

UptimeRobot usually sends a **HEAD** request. The server now answers
`HEAD /health` with `200`. For a lighter check (small response) you can use
`https://<your-service>.onrender.com/healthz`, which also returns `200` but does
not send the full target report.

If the monitor shows "Down": first open `/health` in a browser and check that
`ok: true` comes back, then look for errors in the Render **Logs**. During a
redeploy (~1 min) it may also show Down once; it returns to Up by itself when
the deploy finishes.

---

## 8. Free plan limits (good to know)

- **The disk is not persistent.** If you save the Fallback Chain / Manual
  Selection from the Control Panel (`data/*.json`), it **can be lost on a
  restart or redeploy.**
  Solutions: a paid Render disk, an Oracle Cloud Free VM, or keep the config in
  env vars or the repo (only in a **private** repo, and never with keys).
- **750 free instance hours per month.** One service running 24/7 uses almost
  the whole month, so keep only one free service.
- Waking from sleep can take 30-50 s on the first request.
- All in-memory state (cooldowns, sessions) resets on restart when there are no
  requests.

---

## 9. Troubleshooting

| Problem | Cause / Fix |
|---|---|
| Build fails: `vite: not found` | Check that the Build Command contains `--include=dev` |
| UI does not open, shows `Not found` | `npm run ui:build` did not run. Fix the build command and redeploy |
| Repo is not in the list | GitHub → Settings → Applications → Render → grant repo access |
| `401 Unauthorized` | Check that `Authorization: Bearer <token>` (or `x-api-key: <token>`) is correct and matches `APIROUTER_API_KEYS` |
| No model works | The provider key `*_API_KEYS` or `*_MODELS` / `*_BASE_URL` is not set, or the key is wrong. Check the Health page in the Control Panel |
| The service sleeps | Add UptimeRobot (step 7) |
| Deploy fails but it used to work | Check the error in the logs: Dashboard → service → **Logs** |
| `Port scan timeout` | Make sure `HOST=0.0.0.0` is set, and do not set `PORT` yourself; let Render's value be used |
| `Refusing to start: HOST=0.0.0.0 ... APIROUTER_API_KEYS is empty` | Set `APIROUTER_API_KEYS` (step 4); the server will not listen publicly without a gateway password |
| Saved Custom Endpoints disappear on redeploy | Set all three of `CUSTOM_ENDPOINTS_GITHUB_REPO`, `CUSTOM_ENDPOINTS_GITHUB_TOKEN`, `CUSTOM_ENDPOINTS_SECRET` (step 4). The Custom Endpoints page will show "Saved encrypted in GitHub" |
| Custom Endpoints page shows "GitHub storage is not reachable" | Check that the token is valid (Contents: Read and write on that repo), the repo name is `owner/name`, and `CUSTOM_ENDPOINTS_SECRET` is the same as before. If not, saving/editing is refused and the old data is not overwritten |
| `CUSTOM_ENDPOINTS_SECRET is required` at startup | When a repo is set, both the token and the secret (12+ characters) are required |

To see logs: Dashboard → your service → **Logs** tab.

---

## 10. Security checklist

- [ ] `APIROUTER_API_KEYS` is set (do not leave the gateway open on a public URL)
- [ ] No API key or GitHub token has been committed to the repo (`.env.example` has empty values only)
- [ ] `.env` is in `.gitignore`
- [ ] If a token is ever shared in a chat or screenshot, **revoke it immediately** and create a new one
  (GitHub → Settings → Developer settings → Personal access tokens)
- [ ] If a provider key leaks, go to the provider's dashboard and regenerate it

---

## 11. Shortcut

1. Log in to Render with GitHub and connect the `ApiRouter` repo
2. Web Service: Node, your closest region, `main`, **Free**
3. Build: `npm install --include=dev && npm run ui:build`
4. Start: `npm start`
5. Env: `HOST=0.0.0.0`, `APIROUTER_API_KEYS` + provider keys
6. After deploy: `https://<service>.onrender.com/` (UI) and `.../v1` (Base URL)
7. In UptimeRobot, monitor `/health` every 5 minutes

---

## 12. Deploy with Claude (Render connector)

Instead of clicking through the dashboard, you can connect Render to Claude and
simply ask it to deploy ApiRouter. Claude creates the service, sets the
environment variables it is allowed to set, asks you only for the secrets, then
deploys and checks that the service is healthy.

### What Claude can and cannot do through the Render connector

| Claude can | Claude cannot |
|---|---|
| Create a web service from your repo | Delete services or other resources |
| Add or update environment variables | Change other settings of an existing service (build/start command, instance type, auto-deploy), so a wrong setting has to be fixed in the dashboard |
| Trigger a deploy and watch its status | Set up UptimeRobot (do step 7 yourself) |
| Read logs and metrics to find why a deploy failed | Connect GitHub to Render (do step 2 yourself for a private repo) |

A public repo can be deployed straight from its URL. A private repo needs the
GitHub connection from step 2.

### One-time setup

1. In Render, create an API key: **Account Settings** → **API Keys**.
2. Add Render's hosted MCP server to Claude: URL `https://mcp.render.com/mcp`
   with the header `Authorization: Bearer <YOUR_RENDER_API_KEY>`.

   Claude Code:

   ```bash
   claude mcp add --transport http render https://mcp.render.com/mcp \
     --header "Authorization: Bearer <YOUR_RENDER_API_KEY>"
   ```

   Other Claude clients: add a remote MCP server / connector with the same URL
   and header, following that client's own instructions. Check Render's MCP
   documentation if the setup has changed.
3. Ask Claude, for example:

   > Deploy this repo to Render using the Render connector. Follow
   > `render-setup.md`. Set every non-secret environment variable yourself and
   > tell me exactly which secrets I still have to add.

### Which environment variables Claude sets and which ones you provide

**You provide (secrets and personal choices).** Claude will ask for these and
should not guess them:

| Variable | What it is |
|---|---|
| `APIROUTER_API_KEYS` | Your gateway password. Choose one yourself, or ask Claude to generate one; it will show it once and you must save it |
| `*_API_KEYS` (`GROQ_API_KEYS`, `GEMINI_API_KEYS`, `OPENROUTER_API_KEYS`, ...) | Provider keys, only for the providers you want to use |
| `CLOUDFLARE_ACCOUNT_IDS` | Only if you use Cloudflare |
| `CUSTOM_ENDPOINTS_GITHUB_REPO`, `CUSTOM_ENDPOINTS_GITHUB_TOKEN`, `CUSTOM_ENDPOINTS_SECRET` | Optional, only to keep saved Custom Endpoints across redeploys (see step 4). The repo, token and passphrase are yours to choose and keep |

**Claude sets by itself (no secrets).** These come from `.env.example`, and
Claude keeps its defaults unless you ask for something different:

| Variable | Value |
|---|---|
| `HOST` | `0.0.0.0` (required on Render) |
| `REQUEST_TIMEOUT_MS`, `STREAM_CONNECT_TIMEOUT_MS`, `STREAM_IDLE_TIMEOUT_MS`, `RETRY_STATUS_CODES` | Defaults from `.env.example` |
| `*_BASE_URL` | Provider API roots from `.env.example` |
| `*_MODELS` | Model lists from `.env.example`, or the ones you ask for |
| `AGENTROUTER_ORIGINATOR` (and the optional `AGENTROUTER_*` values) | Defaults from `.env.example` |

**Nobody sets these.** `PORT`, `RENDER_EXTERNAL_URL` and the `KEEPALIVE_*`
variables are handled by Render and the app itself (see step 4).

Render redeploys whenever environment variables change, so ask Claude to set
them in one batch instead of one by one.

### What Claude does

1. Reads `.env.example` and this guide.
2. Creates a Node web service from the repo: branch `main`, build command
   `npm install --include=dev && npm run ui:build`, start command `npm start`.
3. Sets the non-secret variables above and asks you for the secrets.
4. Triggers the deploy, follows its status, and reads the logs if it fails.
5. Opens `/health` to confirm it works, then gives you the UI link and the Base
   URL (`https://<your-service>.onrender.com/v1`).

### Keep it safe

- **Add provider keys in the Render dashboard yourself** (service →
  **Environment**) instead of pasting them into the chat. Anything you paste to
  Claude is visible in that conversation. If you did paste a key, regenerate it
  at the provider.
- A Render API key can access everything in your workspace, not just this
  service. Delete it in **Account Settings** → **API Keys** when the deploy is
  finished, and create a new one next time.
