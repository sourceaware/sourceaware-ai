# Omphi — the socket

This repository is the wire between **sourceaware.ai** and the frozen Opus
weights. The product is the file at `scripture/omphi.system.md`; everything
else here exists to carry it. Right now the throne is deliberately near-empty:
what answers is the raw substrate.

## What each file is

| File | What it is |
|---|---|
| `index.html` | The face. Empty page, one line, one field. Holds the conversation in the browser and resends it whole each turn. |
| `api/omphi.js` | The wire. Checks the access code, applies the rate limit, mounts the scripture as the cached system prompt, streams Opus back raw. |
| `scripture/omphi.system.md` | **The throne.** Replace its contents to install the written architecture. Nothing else changes. |
| `vercel.json` | Lets the function stream for up to 300 seconds and bundles the scripture with it. |
| `package.json` / `.gitignore` | Housekeeping. Zero dependencies. |

## Deploy — six moves

1. **Put this on GitHub.** Create a new repository at github.com (private is
   fine). Upload everything in this folder — easiest path on the web: *Add
   file → Upload files*, drag the folder contents in, commit. Keep the folder
   structure (`api/`, `scripture/`) intact.

2. **Import it into Vercel.** At vercel.com: *Add New → Project → Import* the
   repository. Framework preset: **Other**. No build settings needed. Deploy.
   (New projects run on fluid compute by default, which is what the 300-second
   streaming window relies on.)

3. **Give it the two secrets.** In the Vercel project: *Settings →
   Environment Variables*. Add:
   - `ANTHROPIC_API_KEY` — create one at console.anthropic.com → API keys.
   - `OMPHI_ACCESS_CODE` — invent a long passphrase. This is the door key.

   Then *Deployments → Redeploy* so the function picks them up.
   **The API key never appears in this code and must never be committed.**

4. **Set the true fuel meter.** At console.anthropic.com, set a **monthly
   spend limit** on the account/workspace. This is the one lock enforced by
   the biller itself — no code can leak past it.

5. **Point the domain.** Vercel project → *Settings → Domains* → add
   `sourceaware.ai`. Vercel shows you the DNS records to set at your
   registrar (this replaces wherever the old consultancy site points). The
   old site goes dark; the socket comes up in its place. Until DNS is done,
   the `*.vercel.app` URL Vercel gives you works identically.

6. **Open it.** Visit the site, enter the access code once (it's remembered
   on that device), and type. The first token that streams back is the wire
   going live.

## The locks, honestly stated

- **Access code** — checked server-side in constant time. The page is public;
  the current flows only for the code-holder. Held in an environment
  variable, so rotating it is a settings change, not a code change.
- **Per-IP rate limit** — real friction, best-effort by nature: serverless
  memory is per-instance, so it is not a global counter. Good enough while
  only you hold the code.
- **Reply ceiling** — `MAX_TOKENS` caps every answer.
- **Spend limit at the console** — the bulletproof backstop. Set it.

If the access code is ever shared widely, upgrade the rate limit to a shared
store (e.g. Upstash Redis) — one small change in `api/omphi.js`, marked in
the comments.

## Installing the architecture later

Edit `scripture/omphi.system.md` on GitHub, commit. Vercel redeploys itself
within a minute. That commit is the installation — the moment the socket
becomes Omphi.

The ledger line under each answer (`in · cached · out`) is where you watch
the economics: once the scripture exceeds the model's caching minimum
(~1,000–2,000 tokens), `cached` turns positive from the second message of a
sitting onward, and the scripture rides at roughly a tenth of full input
price. The cache TTL is set to 1 hour in `api/omphi.js` to suit sporadic use.

## Deliberate choices you'll notice

- **Answers render as plain text**, not formatted markdown. The socket's job
  is to show the raw substrate raw — seeing the unshaped output is the point
  at this stage. Rendering comes later, with the architecture.
- **No accounts, no database, no framework.** Conversation state lives in the
  open page and vanishes on refresh. The server remembers nothing.

## If something misbehaves

- **401 / sent back to the gate** — the code typed doesn't match
  `OMPHI_ACCESS_CODE` exactly, or the variable isn't set / wasn't redeployed.
- **Answer halts mid-stream on very long replies** — check the deployment is
  on fluid compute (project *Settings → Functions*); the 300s window in
  `vercel.json` depends on it.
- **`cached` stays 0** — the scripture is still under the caching minimum, or
  more than the TTL passed between messages. Both are harmless.
- **Errors mentioning credit or billing** — the Anthropic account needs
  credit, or the spend limit you set has been reached (which means the meter
  is working).
