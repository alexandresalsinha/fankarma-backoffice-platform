# Fanpage Karma Backoffice

A web backoffice for the [Fanpage Karma](https://www.fanpagekarma.com/) analytics
API. It talks to the **Fanpage Karma MCP server** over HTTP to list your connected
social profiles and lets you **chat** about the profiles you select — the assistant
calls the real API tools live, so every number is grounded in actual data.

- **Left panel** — connected profiles, grouped by network, searchable, multi-select.
- **Right panel** — a streaming chat scoped to the selected profiles. Tool calls
  (`get_profile_metrics`, `get_profile_posts`, …) show up as live chips as they run.
- **Schema viewer** — inspect the MCP tool definitions the backend exposes.

## How it works

```
Browser ──REST/SSE──> Express (server.js)
                         │
             ┌───────────┴───────────┐
       lib/mcp.js                 lib/llm.js
   MCP over HTTP (JSON-RPC     Anthropic Messages API
   + SSE, session mgmt)        (tool-use agent loop)
             │                        │
   app.fanpagekarma.com/mcp    LLM endpoint (.env)
```

`POST /api/chat` runs an agentic loop: the LLM is given the Fanpage Karma tools and
the selected profiles (via the system prompt), calls the tools through the MCP client,
and streams text + tool activity back to the browser as Server-Sent Events.

## Setup

Requires Node 18+ (developed on Node 24).

```bash
npm install
npm start          # http://localhost:4000
```

## Configuration (`.env`)

```ini
# Fanpage Karma MCP (HTTP transport)
FPK_MCP_URL=https://app.fanpagekarma.com/api/v2/mcp
FPK_AUTH=Bearer <your-fanpage-karma-token>

# LLM powering the chat (any Anthropic /v1/messages-compatible endpoint)
LLM_BASE_URL=https://api.deepseek.com/anthropic
LLM_API_KEY=<your-key>
LLM_MODEL=deepseek-v4-pro[1m]

PORT=4000
```

To use Anthropic's own API instead, set `LLM_BASE_URL=https://api.anthropic.com`,
`LLM_API_KEY=<anthropic-key>`, `LLM_MODEL=claude-sonnet-5`.

## API

| Endpoint            | Purpose                                             |
| ------------------- | --------------------------------------------------- |
| `GET  /api/profiles`| Connected profiles (`list_connected_profiles`)      |
| `GET  /api/schema`  | MCP tool definitions                                |
| `POST /api/chat`    | Streaming chat (SSE): `{ messages, profiles }`      |

## Notes

- Some Facebook avatar URLs are hotlink-protected; broken images hide gracefully.
- The MCP client re-initializes automatically if the server drops the session.
- Never invents metrics — if the model lacks data it calls a tool or says so.
