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

# LLM powering the chat (any Anthropic /v1/messages- or OpenAI
# /chat/completions-compatible endpoint)
LLM_BASE_URL=https://api.deepseek.com/anthropic
LLM_API_KEY=<your-key>
LLM_MODEL=deepseek-v4-pro[1m]

PORT=4000
```

`lib/llm.js` speaks two wire formats and normalizes both to the same internal
(Anthropic-shaped) representation:

- **Anthropic Messages API** (`POST {LLM_BASE_URL}/v1/messages`) — the default.
- **OpenAI Chat Completions** (`POST {LLM_BASE_URL}/chat/completions`) — used
  automatically when `LLM_BASE_URL` ends in an `/openai` (or `/openai/v1`, ...)
  segment, e.g. Azure AI Foundry's OpenAI-compatible surface:
  ```ini
  LLM_BASE_URL=https://<resource>.services.ai.azure.com/openai/v1
  LLM_API_KEY=<azure-ai-foundry-key>
  LLM_MODEL=<deployment-name>
  ```
  Set `LLM_API_STYLE=openai` or `LLM_API_STYLE=anthropic` to override the
  auto-detection explicitly.

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
