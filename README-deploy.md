# Deploying Second Look publicly

This turns "Second Look" from a private Claude Artifact into a real public
website anyone can open, with no Claude account required. There are two
pieces, and they get deployed separately:

1. **`worker.js`** — a tiny backend that holds your OpenAI API key and
   makes the AI-check call. It never touches the browser directly.
2. **`index.html`** — the actual site. Static HTML/CSS/JS, hostable
   anywhere. Talks to the Worker over the network for the AI check; does
   everything else (spelling pass, speech, progress tracking) entirely in
   the visitor's own browser.

You do the actual account creation and key-pasting yourself — that's not
something Claude enters on your behalf, by design (an assistant that could
type in API keys and payment info is an assistant that's dangerous to have
around).

**Cost note up front:** every visitor who runs the deeper AI check spends a
little of *your* OpenAI API budget (not theirs — that was the whole tradeoff
of making this public instead of gating it behind Claude accounts). Keep an
eye on usage at [platform.openai.com/usage](https://platform.openai.com/usage)
early on, especially once you share the link widely. The two models this
uses by default — `gpt-5-mini` for the full paragraph check, `gpt-5-nano`
for the quick single-word voice clarification — are OpenAI's cheaper tiers;
check [platform.openai.com/docs/models](https://platform.openai.com/docs/models)
if either name ever stops working (model lineups shift over time) and swap
the model strings in `index.html` and `worker.js`'s `DEFAULT_MODEL`.

---

## Part 1 — Deploy the AI backend (Cloudflare Worker)

Cloudflare Workers has a generous free tier (100,000 requests/day) and this
needs almost none of that, so it costs nothing to run beyond your OpenAI
API usage.

1. **Get an OpenAI API key**, if you don't have one already: sign in at
   [platform.openai.com](https://platform.openai.com) → **API Keys** →
   **Create new secret key**. Copy it somewhere safe for a moment — you'll
   paste it directly into Cloudflare in step 4, not anywhere else. (This is
   a separate account/surface from ChatGPT's consumer app, same as how
   Anthropic's API keys live on a separate console from Claude.ai.)

2. **Create a free Cloudflare account** at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)
   if you don't have one.

3. **Install Wrangler** (Cloudflare's CLI) if you have Node.js on your
   machine — or skip to the dashboard-only path below if you'd rather not
   install anything.

   ```bash
   npm install -g wrangler
   wrangler login          # opens a browser window to authorize
   ```

   From this folder (containing `worker.js` and `wrangler.toml`):

   ```bash
   wrangler deploy
   ```

   This prints a URL like `https://second-look-ai.YOUR-SUBDOMAIN.workers.dev`
   — that's your Worker URL. Keep it.

4. **Set your API key as a secret** (this is the step where the key
   actually goes in — do this yourself, in your own terminal or the
   Cloudflare dashboard, never by pasting it into a chat with Claude):

   ```bash
   wrangler secret put OPENAI_API_KEY
   ```

   It'll prompt you to paste the key. This stores it encrypted on
   Cloudflare's side; it's never written into any file in this folder.

   **No CLI? Dashboard-only path instead:** in the Cloudflare dashboard, go
   to **Workers & Pages** → **Create** → **Create Worker**, give it a name,
   click through to the editor, paste in the contents of `worker.js`,
   **Deploy**. Then go to that Worker's **Settings → Variables and Secrets**,
   add a secret named `OPENAI_API_KEY` with your key as the value, save.

5. **Test it's alive** (optional but reassuring):

   ```bash
   curl -X POST https://YOUR-WORKER-URL/ai \
     -H "Content-Type: application/json" \
     -d '{"prompt":"Reply with exactly: [{\"ok\":true}]"}'
   ```

   You should get back `{"text":"[{\"ok\":true}]"}` or similar — not an
   error.

---

## Part 2 — Point the site at your Worker

Open `index.html` in a text editor, find this line near the top of the
`<script>` section:

```js
var WORKER_URL = "https://YOUR-WORKER-SUBDOMAIN.workers.dev";
```

Replace it with the real URL from Part 1, step 3. Save.

(Until you do this, the site still works — the local/instant spelling check
runs fine — it just shows a small banner saying the deeper AI check isn't
set up yet, instead of failing confusingly.)

---

## Part 3 — Host the site itself

Pick whichever's easiest for you — all are free for a static page like this:

### Option A: Cloudflare Pages (keeps everything in one place)
1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Upload assets**.
2. Upload just the one `index.html` file (rename it to exactly `index.html`
   if it isn't already).
3. It gives you a `*.pages.dev` URL immediately. Done.

### Option B: Netlify Drop (fastest, no account strictly required)
1. Go to [app.netlify.com/drop](https://app.netlify.com/drop).
2. Drag `index.html` onto the page.
3. It gives you a live URL in seconds.

### Option C: GitHub Pages (if you already use GitHub)
1. Create a new repo, add `index.html` to it (as `index.html` at the repo
   root, or inside a `docs/` folder).
2. Repo **Settings → Pages** → set the source branch/folder → Save.
3. GitHub gives you a `https://<you>.github.io/<repo>/` URL after a minute.

Once it's live, open the URL in a normal browser tab (not embedded in
anything) and the microphone ("Say it") button should also work normally —
that was blocked before specifically because the artifact was running
embedded inside Claude's own page; a real top-level site doesn't have that
restriction.

---

## Cost safeguards already built in

Three things keep this from running up an unexpected bill, in order of how
strong a guarantee each one actually gives:

1. **A real per-session dollar cap ($0.20 by default).** Every AI call gets
   back the exact token counts OpenAI billed for it, and `index.html` turns
   those into real dollars using OpenAI's list price (`MODEL_PRICING` near
   the top of the AI-related script — currently gpt-5-mini at $0.25/1M input
   + $2.00/1M output, gpt-5-nano at $0.05/1M input + $0.40/1M output; these
   are OpenAI's published rates as of September 2026, re-check
   [platform.openai.com/docs/pricing](https://platform.openai.com/docs/pricing)
   if you ever suspect they've changed). It keeps a running total per browser
   tab in `sessionStorage`; once a session crosses `SESSION_BUDGET_USD`, the
   AI check quietly turns itself off for the rest of that session — the
   instant/local check keeps working regardless. In practice this is a very
   generous ceiling: at these prices, one full-paragraph AI check costs well
   under a cent, so $0.20 covers dozens of checks per sitting.
   **The honest limit:** this only bounds *one browser session*. It's
   `sessionStorage`, so it resets the moment someone opens a new tab or
   closes and reopens the old one — it protects against an accidental
   runaway loop or a student mashing the check button, not against someone
   deliberately trying to run up your bill.
2. **The Worker only ever calls `gpt-5-mini` or `gpt-5-nano`, no matter what
   a request asks for.** Since this endpoint is public and unauthenticated,
   anyone could otherwise bypass your page entirely and POST directly to
   your Worker URL asking for a pricier model — the `ALLOWED_MODELS`
   allow-list in `worker.js` closes that off.
3. **`MAX_PROMPT_CHARS` and `MAX_TOKENS_CAP`** in `worker.js` put a hard
   ceiling on the size of any single request/response regardless of what's
   asked for, so one abusive call can only cost so much.

None of that stops a determined person from just opening many tabs (or
calling your Worker directly from a script) to rack up many small charges —
that requires the two steps below, and neither is required just to get this
working:

- **Add a Cloudflare rate-limiting rule** on the Worker's route (dashboard →
  your Worker → **Triggers**/**Security** → rate limiting) to cap requests
  per visitor IP per minute — this is the actual server-side backstop
  against someone hammering the endpoint directly, since sessionStorage
  can't see across tabs or people.
- **Restrict the Worker's CORS to your real domain.** Right now
  `ALLOWED_ORIGIN` is set to `*` in `wrangler.toml` (anyone's page can call
  your Worker). Once you know your site's real URL, change it to that exact
  origin (e.g. `https://tinimini12.github.io`) and redeploy — this stops
  *other sites'* pages from quietly using your API key through your Worker
  (it doesn't stop someone calling the Worker directly with curl/a script,
  since that's not subject to CORS at all — only the rate-limiting rule
  above covers that case).
- **Watch usage** at [platform.openai.com/usage](https://platform.openai.com/usage)
  the first week or two after sharing it widely, so a cost surprise doesn't
  sneak up on you.

---

## What's different from the private (Claude Artifact) version

- **AI check**: was "free" to you because each viewer spent their own Claude
  usage; now it's billed to your OpenAI API key for every visitor, using
  OpenAI's models instead of Claude's. The prompts and merge logic are
  unchanged, so behavior should be comparable, but it's a different model
  family underneath — worth spot-checking against the original test
  paragraphs once it's live.
- **Progress tracking**: was a shared database visible from any device; now
  it's `localStorage`, so it's private to one browser and won't follow a
  student across devices or survive them clearing site data. If you want
  real cross-device accounts + a shared database later, that's a bigger
  follow-up project (real auth, a real database) — let me know if you want
  to scope that out.
- **Microphone ("Say it")**: should now work normally, since the page is no
  longer embedded inside Claude's own UI.
