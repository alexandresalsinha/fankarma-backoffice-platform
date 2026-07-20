// Minimal Model Context Protocol client over the "Streamable HTTP" transport.
// Handles the initialize handshake, session-id management, SSE response parsing,
// and automatic re-initialization if the server drops our session.

const PROTOCOL_VERSION = "2024-11-05";

let sessionId = null;
let idCounter = 0;

function endpoint() {
  const url = process.env.FPK_MCP_URL;
  if (!url) throw new Error("FPK_MCP_URL is not configured");
  return url;
}

// The server answers with `text/event-stream`. Each event carries a `data:` line
// holding a JSON-RPC message. Fall back to plain-JSON parsing just in case.
function parseResponse(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  if (trimmed[0] === "{" || trimmed[0] === "[") return JSON.parse(trimmed);

  const dataLines = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  for (const d of dataLines) {
    try {
      const obj = JSON.parse(d);
      if (obj && (obj.result !== undefined || obj.error !== undefined)) return obj;
    } catch {
      /* keep looking */
    }
  }
  try {
    return JSON.parse(dataLines.join(""));
  } catch {
    return null;
  }
}

async function post(body, { notification = false } = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: process.env.FPK_AUTH,
    "MCP-Protocol-Version": PROTOCOL_VERSION,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const res = await fetch(endpoint(), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  if (notification) return { status: res.status, message: null };

  const text = await res.text();
  return { status: res.status, message: parseResponse(text) };
}

async function ensureSession() {
  if (sessionId) return;
  const init = await post({
    jsonrpc: "2.0",
    id: ++idCounter,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "fankarma-backoffice", version: "1.0.0" },
    },
  });
  if (init.message?.error) {
    throw new Error(`MCP initialize failed: ${init.message.error.message}`);
  }
  // Best-effort "initialized" notification; server may reply 202 with no body.
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { notification: true });
}

async function rpc(method, params) {
  await ensureSession();

  let res = await post({ jsonrpc: "2.0", id: ++idCounter, method, params });

  // Session expired / not found → re-initialize once and retry.
  const invalidSession =
    res.status === 404 ||
    res.status === 400 ||
    res.message?.error?.code === -32001;
  if (invalidSession) {
    sessionId = null;
    await ensureSession();
    res = await post({ jsonrpc: "2.0", id: ++idCounter, method, params });
  }

  if (res.message?.error) {
    throw new Error(res.message.error.message || `MCP error on ${method}`);
  }
  return res.message?.result;
}

export function listTools() {
  return rpc("tools/list", {});
}

export function callTool(name, args) {
  return rpc("tools/call", { name, arguments: args || {} });
}

// Fanpage Karma tools return their payload as content[].text (a JSON string).
// Collapse the content array into one text blob.
export function contentToText(result) {
  if (!result?.content) return "";
  return result.content
    .map((c) => (typeof c.text === "string" ? c.text : JSON.stringify(c)))
    .join("\n");
}
