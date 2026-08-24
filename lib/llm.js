// Thin wrapper around an Anthropic-Messages-compatible chat endpoint.

function config() {
  const baseUrl =
    process.env.LLM_BASE_URL ||
    process.env.ANTHROPIC_BASE_URL_PowerToys_clear_anthropic_default_llm ||
    process.env.ANTHROPIC_BASE_URL;
  const apiKey =
    process.env.LLM_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN_PowerToys_clear_anthropic_default_llm ||
    process.env.ANTHROPIC_API_KEY;
  const model =
    process.env.LLM_MODEL ||
    process.env.ANTHROPIC_MODEL_PowerToys_clear_anthropic_default_llm ||
    "claude-sonnet-5";
  if (!baseUrl || !apiKey) {
    throw new Error("LLM is not configured (set LLM_BASE_URL and LLM_API_KEY).");
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, model };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One (non-streaming) round of the Anthropic Messages API, with light retry on
// transient network errors / 5xx (the DeepSeek endpoint occasionally drops a call).
export async function createMessage({ system, messages, tools, maxTokens = 4096, model: modelOverride }) {
  const { baseUrl, apiKey, model: defaultModel } = config();
  const model = modelOverride || defaultModel;
  const payload = JSON.stringify({ model, max_tokens: maxTokens, system, tools, messages });

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          Authorization: `Bearer ${apiKey}`,
          "anthropic-version": "2023-06-01",
        },
        body: payload,
      });

      if (res.status >= 500) {
        lastErr = new Error(`LLM ${res.status}`);
        await sleep(400 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`LLM request failed (${res.status}): ${body.slice(0, 300)}`);
      }
      return await res.json();
    } catch (e) {
      lastErr = e; // network-level "fetch failed" → retry
      await sleep(400 * (attempt + 1));
    }
  }
  throw new Error(`LLM unavailable: ${lastErr?.message || "unknown error"}`);
}
