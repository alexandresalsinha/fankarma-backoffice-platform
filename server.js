import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listTools, callTool, contentToText } from "./lib/mcp.js";
import { createMessage } from "./lib/llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

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
app.get("/api/profiles", async (_req, res) => {
  try {
    const result = await callTool("list_connected_profiles", {});
    const parsed = JSON.parse(contentToText(result));
    res.json({
      profiles: parsed?.data?.profiles || [],
      total: parsed?.metadata?.total_profiles ?? (parsed?.data?.profiles?.length || 0),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── System prompt anchoring the assistant to the selected profiles ─────
function buildSystemPrompt(profiles) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    "You are the analytics assistant inside a Fanpage Karma backoffice.",
    "You answer questions about social-media profiles using the Fanpage Karma tools available to you.",
    `Today's date is ${today}. When a tool needs a date range and none is given, omit the dates (the API defaults to the last 28 days).`,
    "",
    "Guidelines:",
    "- Use the tools to fetch real data before answering; never invent metrics.",
    "- `network` values must be lowercase (facebook, instagram, youtube, linkedin, tiktok, ...).",
    "- Use `list_available_metrics` when you are unsure which metric keys a network/endpoint supports.",
    "- Answer concisely in Markdown. Use tables when comparing profiles, and format large numbers readably.",
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
      "No profiles are currently selected. Ask the user to select one or more profiles from the left panel, or help them decide which to pick.",
    );
  }
  return lines.join("\n");
}

// ── Chat: agentic tool-use loop, streamed to the client as SSE ─────────
app.post("/api/chat", async (req, res) => {
  const { messages = [], profiles = [] } = req.body || {};

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

    const MAX_STEPS = 8;
    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await createMessage({ system, messages: convo, tools });
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
