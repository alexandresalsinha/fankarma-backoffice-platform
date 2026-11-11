# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Internal FullSix team members (account managers / social media analysts) who manage social profiles for FullSix's clients. There is no client-facing login today — the UI's "Iniciar sessão" button is an unwired placeholder, and all current usage is internal.

## Product Purpose

Karma Full6 is a backoffice that connects to the Fanpage Karma analytics API (via its MCP server) to list connected social profiles and let the team query their performance. Users pick one or more connected profiles, see a KPI dashboard (followers, likes, per-network breakdown) for a chosen date range, and chat with an AI assistant scoped to the selected profiles. Success means the team can get fast, trustworthy answers about real client social performance without manually pulling reports from Fanpage Karma.

## Positioning

The chat is not a report summarizer over cached/stale data — it's an agentic loop that calls the real Fanpage Karma MCP tools (`get_profile_metrics`, `get_profile_posts`, etc.) live, scoped to the selected profiles, and streams both the tool activity and the answer back to the user. Every number in a response is grounded in an actual API call; the assistant is explicitly designed to never invent metrics, calling a tool or admitting it lacks data instead.

## Operating Context

- Social profiles are grouped by network (Facebook, Instagram, etc.) in a searchable, multi-select left panel.
- A curated bank of 16 strategic analysis questions (`new_questions.txt`, in Portuguese) drives an "insights picker" — users opt into questions like "what drove the top vs. bottom posts," "which comment themes are new this period," "which organic posts should have been promoted" — and the assistant answers them against the selected profiles' real data.
- A schema viewer lets users inspect the MCP tool definitions the backend exposes.
- Settings allow switching the LLM model and updating the Fanpage Karma API key (`FPK_AUTH`) without redeploying.
- The MCP client session can drop and silently re-initializes.

## Capabilities and Constraints

- UI language is European Portuguese (`lang="pt"`) throughout; this is a durable requirement, not a placeholder.
- Backend: Express (`server.js`) talking to the Fanpage Karma MCP over HTTP (JSON-RPC + SSE) via `lib/mcp.js`, and to an LLM via `lib/llm.js`, which normalizes both Anthropic Messages API and OpenAI Chat Completions-compatible wire formats.
- No client-facing authentication exists yet; the login button is a known placeholder for future auth, not a current capability.
- Some Facebook avatar URLs are hotlink-protected and must degrade gracefully (broken images hide rather than show a broken-image icon).

## Brand Commitments

- Product name in the UI is "Karma Full6" (topbar), owned by FullSix; the favicon is currently a generic 📊 emoji placeholder, not a designed mark.

## Accessibility & Inclusion

Target WCAG 2.2 AA for all future design and build work on this product.

## Product Principles

1. Never fabricate a metric — every number shown to the user traces back to a live Fanpage Karma API call.
2. Keep answers scoped to the profiles the user explicitly selected; don't blend data across unselected clients.
3. Internal-tool pragmatism: this serves FullSix's own analysts first, not an external client-facing product (yet) — prioritize their workflow speed over onboarding or marketing polish.
4. Portuguese-first: all user-facing copy is European Portuguese.
