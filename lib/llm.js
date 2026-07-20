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

// One (non-streaming) round of the Anthropic Messages API.
export async function createMessage({ system, messages, tools, maxTokens = 4096 }) {
  const { baseUrl, apiKey, model } = config();
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      Authorization: `Bearer ${apiKey}`,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, tools, messages }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}
