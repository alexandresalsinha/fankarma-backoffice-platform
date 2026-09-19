// Thin wrapper around the chat LLM. Speaks either the Anthropic Messages API
// shape or the OpenAI Chat Completions shape (e.g. Azure AI Foundry's
// `/openai/v1` surface) and normalizes both to the Anthropic response shape
// the rest of the app (server.js) is written against.

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
  const cleanBaseUrl = baseUrl.replace(/\/$/, "");

  // LLM_API_STYLE overrides auto-detection; otherwise a base URL ending in
  // an `/openai` (or `/openai/v1`, ...) segment — e.g. Azure AI Foundry's
  // OpenAI-compatible surface — is treated as OpenAI Chat Completions.
  const styleOverride = (process.env.LLM_API_STYLE || "").trim().toLowerCase();
  const style =
    styleOverride === "openai" || styleOverride === "anthropic"
      ? styleOverride
      : /\/openai(\/v\d+)?$/i.test(cleanBaseUrl)
        ? "openai"
        : "anthropic";

  return { baseUrl: cleanBaseUrl, apiKey, model, style };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Anthropic (internal) → OpenAI request shape ─────────────────────────
function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: "system", content: system });

  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];

    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      const toolUses = blocks.filter((b) => b.type === "tool_use");
      const msg = { role: "assistant", content: text || null };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) },
        }));
      }
      out.push(msg);
    } else {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (text) out.push({ role: "user", content: text });
      for (const tr of blocks.filter((b) => b.type === "tool_result")) {
        out.push({
          role: "tool",
          tool_call_id: tr.tool_use_id,
          content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
        });
      }
    }
  }
  return out;
}

function toOpenAITools(tools) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));
}

// ── OpenAI response shape → Anthropic (internal) shape ──────────────────
function fromOpenAIResponse(json) {
  const choice = json?.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      // malformed arguments from the model → leave input empty rather than throw
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
  }
  const stop_reason = choice.finish_reason === "tool_calls" ? "tool_use" : choice.finish_reason === "length" ? "max_tokens" : "end_turn";
  return { content, stop_reason };
}

// One (non-streaming) round of chat, with light retry on transient network
// errors / 5xx (upstream providers occasionally drop a call).
export async function createMessage({ system, messages, tools, maxTokens = 4096, model: modelOverride }) {
  const { baseUrl, apiKey, model: defaultModel, style } = config();
  const model = modelOverride || defaultModel;
  const isOpenAI = style === "openai";

  const url = isOpenAI ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/messages`;
  const headers = isOpenAI
    ? { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "api-key": apiKey }
    : {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        Authorization: `Bearer ${apiKey}`,
        "anthropic-version": "2023-06-01",
      };
  const payload = JSON.stringify(
    isOpenAI
      ? { model, max_tokens: maxTokens, messages: toOpenAIMessages(system, messages), tools: toOpenAITools(tools) }
      : { model, max_tokens: maxTokens, system, tools, messages },
  );

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers, body: payload });

      if (res.status >= 500) {
        lastErr = new Error(`LLM ${res.status}`);
        await sleep(400 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`LLM request failed (${res.status}): ${body.slice(0, 300)}`);
      }
      const json = await res.json();
      return isOpenAI ? fromOpenAIResponse(json) : json;
    } catch (e) {
      lastErr = e; // network-level "fetch failed" → retry
      await sleep(400 * (attempt + 1));
    }
  }
  throw new Error(`LLM unavailable: ${lastErr?.message || "unknown error"}`);
}
