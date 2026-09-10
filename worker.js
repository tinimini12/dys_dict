/**
 * Second Look -- AI backend (Cloudflare Worker)
 *
 * This is the one piece that has to live on a server instead of in the
 * browser: it holds your real Anthropic API key and makes the actual model
 * call, so a public visitor's browser never sees the key. The page sends it
 * an already-written prompt and gets back the model's raw text reply; all
 * the "what should the prompt say" logic stays in public_index.html so you
 * can tweak wording without redeploying this file.
 *
 * Deploy: see README-deploy.md in this same folder for the full walkthrough.
 * You will set ANTHROPIC_API_KEY yourself, directly in the Cloudflare
 * dashboard or via `wrangler secret put` -- never paste it into this file,
 * and never send it to anyone (including Claude) to type in for you.
 */

const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_PROMPT_CHARS = 8000;     // guards against someone sending huge/abusive requests
const MAX_TOKENS_CAP = 1500;       // hard ceiling regardless of what the client asks for

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/ai") {
      return json({ error: "not_found" }, 404, cors);
    }
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405, cors);
    }
    if (!env.ANTHROPIC_API_KEY) {
      // you deployed the Worker but haven't set the secret yet -- see README-deploy.md
      return json({ error: "server_not_configured" }, 500, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "bad_request" }, 400, cors);
    }

    const prompt = typeof body.prompt === "string" ? body.prompt.slice(0, MAX_PROMPT_CHARS) : "";
    if (!prompt.trim()) {
      return json({ error: "empty_prompt" }, 400, cors);
    }
    const model = typeof body.model === "string" && body.model ? body.model : DEFAULT_MODEL;
    const maxTokens = Math.min(
      Number.isFinite(body.maxTokens) ? Math.max(1, Math.floor(body.maxTokens)) : 800,
      MAX_TOKENS_CAP
    );

    let anthropicResp;
    try {
      anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
    } catch (e) {
      return json({ error: "upstream_network_error" }, 502, cors);
    }

    if (anthropicResp.status === 429) {
      // pass Anthropic's own rate-limit signal straight through so the page
      // can show "try again in a bit" instead of a generic failure
      return json({ error: "rate_limited" }, 429, cors);
    }
    if (!anthropicResp.ok) {
      const detail = await safeText(anthropicResp);
      return json({ error: "upstream_error", detail: detail.slice(0, 500) }, 502, cors);
    }

    let data;
    try {
      data = await anthropicResp.json();
    } catch (e) {
      return json({ error: "upstream_bad_json" }, 502, cors);
    }
    const text = (data.content && data.content[0] && data.content[0].text) || "";
    return json({ text: text }, 200, cors);
  },
};

function corsHeaders(env) {
  // Default is wide open (*) so this works the moment you deploy it. Once
  // you know the real domain your site lives on, set ALLOWED_ORIGIN to it
  // (Cloudflare dashboard -> your Worker -> Settings -> Variables) so other
  // sites can't quietly ride on your API key by calling this Worker from
  // their own pages.
  const origin = env.ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: Object.assign({ "Content-Type": "application/json" }, headers),
  });
}

async function safeText(resp) {
  try {
    return await resp.text();
  } catch (e) {
    return "";
  }
}
