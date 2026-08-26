import "dotenv/config";
import express from "express";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listTools, callTool, contentToText } from "./lib/mcp.js";
import { createMessage } from "./lib/llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf8"));
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── LLM models offered in the top-bar dropdown ─────────────────────────
// The default mirrors lib/llm.js's resolution; the selectable list can be
// overridden with LLM_MODELS (comma-separated). The configured default is
// always present and shown first so the UI and backend never disagree.
const DEFAULT_MODEL =
  process.env.LLM_MODEL ||
  process.env.ANTHROPIC_MODEL_PowerToys_clear_anthropic_default_llm ||
  "claude-sonnet-5";
const AVAILABLE_MODELS = (() => {
  const fromEnv = (process.env.LLM_MODELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const list = fromEnv.length ? fromEnv : [DEFAULT_MODEL, "deepseek-chat", "deepseek-reasoner"];
  return [...new Set([DEFAULT_MODEL, ...list])];
})();

// ── Settings persistence (the ⚙ modal) ────────────────────────────────
const ENV_PATH = path.join(__dirname, ".env");

// Show only the tail of a secret so the UI can confirm it is set without
// ever shipping the full value to the browser.
function maskSecret(s) {
  const v = String(s || "");
  if (!v) return "";
  return v.length <= 4 ? "••••" : "••••" + v.slice(-4);
}

// Upsert a single KEY=value line in .env, preserving all other lines/comments.
// Values are written unquoted (matching the existing file style); newlines are
// stripped so a pasted token can never inject extra env lines.
function updateEnvFile(key, value) {
  const clean = String(value).replace(/[\r\n]+/g, " ").trim();
  let text = "";
  try {
    text = readFileSync(ENV_PATH, "utf8");
  } catch {
    text = "";
  }
  const line = `${key}=${clean}`;
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  if (re.test(text)) {
    text = text.replace(re, line);
  } else {
    text = text.replace(/\s*$/, "") + `\n${line}\n`;
  }
  writeFileSync(ENV_PATH, text);
}

// ── REST: platform version + selectable LLM models + settings state ────
app.get("/api/config", (_req, res) => {
  res.json({
    version: pkg.version,
    models: AVAILABLE_MODELS,
    defaultModel: DEFAULT_MODEL,
    fpkAuth: { configured: Boolean(process.env.FPK_AUTH), preview: maskSecret(process.env.FPK_AUTH) },
  });
});

// ── REST: update platform settings (persisted to .env + live process.env) ─
app.post("/api/settings", (req, res) => {
  const { fpkAuth } = req.body || {};
  try {
    if (typeof fpkAuth === "string" && fpkAuth.trim()) {
      const value = fpkAuth.trim();
      process.env.FPK_AUTH = value;   // takes effect immediately (read live per request)
      updateEnvFile("FPK_AUTH", value);
    }
    res.json({
      ok: true,
      fpkAuth: { configured: Boolean(process.env.FPK_AUTH), preview: maskSecret(process.env.FPK_AUTH) },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cache the MCP tool schema (used both as "schema" and as LLM tools) ──
let toolCache = null;
async function getTools() {
  if (!toolCache) {
    const result = await listTools();
    toolCache = result?.tools || [];
  }
  return toolCache;
}

// Convert MCP tool definitions → Anthropic tool format.
function toLLMTools(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description || "",
    input_schema: t.inputSchema || { type: "object", properties: {} },
  }));
}

// ── REST: the "schema" (MCP tool definitions) ──────────────────────────
app.get("/api/schema", async (_req, res) => {
  try {
    const tools = await getTools();
    res.json({ tools });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── REST: connected profiles (the "data" for the left panel) ───────────
// Fetched straight from the Fanpage Karma v2 REST API — no MCP session/handshake.
// Base is derived from FPK_MCP_URL (…/api/v2/mcp → …/api/v2).
const REST_BASE =
  (process.env.FPK_MCP_URL || "").replace(/\/mcp\/?$/, "") ||
  "https://app.fanpagekarma.com/api/v2";

app.get("/api/profiles", async (_req, res) => {
  try {
    const r = await fetch(`${REST_BASE}/profiles/connected`, {
      headers: { Authorization: process.env.FPK_AUTH, Accept: "application/json" },
    });
    const parsed = await r.json();
    if (!r.ok) throw new Error(parsed?.error?.message || `Fanpage Karma API returned ${r.status}`);
    res.json({
      profiles: parsed?.data?.profiles || [],
      total: parsed?.metadata?.total_profiles ?? (parsed?.data?.profiles?.length || 0),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── REST: per-profile KPI metrics for the live dashboard ───────────────
// Called once per selected (network, profile) via the MCP get_profile_metrics
// tool. We only pull the two cross-network common keys we display, keeping the
// payload small. Followers = total profile followers; Likes = likes on posts
// in the period (defaults to the last 28 days).
app.get("/api/metrics", async (req, res) => {
  const network = String(req.query.network || "").toLowerCase();
  const profile_id = String(req.query.profile_id || "");
  if (!network || !profile_id) {
    return res.status(400).json({ error: "network and profile_id are required" });
  }
  try {
    const result = await callTool("get_profile_metrics", {
      network,
      profile_id,
      metrics: "common_followers_count,common_likes_count",
    });
    const parsed = JSON.parse(contentToText(result));
    const data = parsed?.data || {};
    res.json({
      network,
      profile_id,
      followers: Number(data.common_followers_count?.value) || 0,
      likes: Number(data.common_likes_count?.value) || 0,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── System prompt anchoring the assistant to the selected profiles ─────
function buildSystemPrompt(profiles) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    "RESPONDE SEMPRE EM PORTUGUÊS DE PORTUGAL. Even if the user writes in English or another language, every word of your reply — text, table headers, explanations — MUST be in European Portuguese (português de Portugal). This overrides everything else.",
    "",
    "You are the analytics assistant inside a Fanpage Karma backoffice.",
    "You answer questions about social-media profiles using the Fanpage Karma tools available to you.",
    `Today's date is ${today}. When a tool needs a date range and none is given, omit the dates (the API defaults to the last 28 days).`,
    "",
    "Guidelines:",
    "- Use the tools to fetch real data before answering; never invent metrics.",
    "- `network` values must be lowercase (facebook, instagram, youtube, linkedin, tiktok, ...).",
    "- Use `list_available_metrics` when you are unsure which metric keys a network/endpoint supports.",
    "- Answer concisely in Markdown, in Portuguese. Use tables when comparing profiles, and format large numbers readably (e.g. 2.393).",
  ];

  if (profiles?.length) {
    lines.push(
      "",
      `The user has selected ${profiles.length} profile(s). Restrict your analysis to these unless asked otherwise:`,
    );
    for (const p of profiles) {
      lines.push(
        `- ${p.profile_name} — network=${p.network}, profile_id=${p.profile_id}, username=@${p.username}`,
      );
    }
  } else {
    lines.push(
      "",
      "No profiles are currently selected. In Portuguese, ask the user to select one or more profiles from the left panel, or help them decide which to pick.",
    );
  }
  return lines.join("\n");
}

// ── Chat: agentic tool-use loop, streamed to the client as SSE ─────────
app.post("/api/chat", async (req, res) => {
  const { messages = [], profiles = [], model } = req.body || {};
  // Only honour a model the server actually offers; otherwise fall back to the
  // configured default (createMessage resolves undefined → default).
  const chatModel = AVAILABLE_MODELS.includes(model) ? model : undefined;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const mcpTools = await getTools();
    const tools = toLLMTools(mcpTools);
    const system = buildSystemPrompt(profiles);

    // Seed conversation with the client-side history (plain-text turns).
    const convo = messages.map((m) => ({
      role: m.role,
      content: String(m.content ?? ""),
    }));

    // Some models under-weight the system prompt's language directive, so we also
    // pin it to the final user turn, where it is followed most reliably.
    for (let i = convo.length - 1; i >= 0; i--) {
      if (convo[i].role === "user") {
        convo[i].content +=
          "\n\n[Instrução: responde a esta mensagem inteiramente em português de Portugal.]";
        break;
      }
    }

    const MAX_STEPS = 8;
    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await createMessage({ system, messages: convo, tools, model: chatModel });
      const content = Array.isArray(reply.content) ? reply.content : [];

      const text = content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (text) send("text", { text });

      const toolUses = content.filter((c) => c.type === "tool_use");

      // Store the assistant turn (drop thinking blocks to avoid signature issues).
      convo.push({
        role: "assistant",
        content: content.filter((c) => c.type === "text" || c.type === "tool_use"),
      });

      if (reply.stop_reason !== "tool_use" || toolUses.length === 0) break;

      const toolResults = [];
      for (const tu of toolUses) {
        send("tool", { id: tu.id, name: tu.name, input: tu.input, status: "running" });
        try {
          const result = await callTool(tu.name, tu.input);
          const out = contentToText(result);
          send("tool", { id: tu.id, name: tu.name, status: "done" });
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: out });
        } catch (e) {
          send("tool", { id: tu.id, name: tu.name, status: "error", error: e.message });
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Error: ${e.message}`,
            is_error: true,
          });
        }
      }
      convo.push({ role: "user", content: toolResults });
    }

    send("done", {});
  } catch (e) {
    send("error", { error: e.message });
  } finally {
    res.end();
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n  Fanpage Karma backoffice → http://localhost:${PORT}\n`);
});
