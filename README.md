# Qwen Slurp

OpenAI-compatible proxy **+ full Qwen Web UI reverse proxy** for chat.qwen.ai. Uses the desktop app's API path (`source: desktop`) to bypass the Alibaba Baxia WAF. Authenticates with email/password login (SHA-256 hashed).

## Quick Start

```bash
# Configure credentials in .config/config.json
# Start the proxy
node src/server.js
```

Runs on `http://127.0.0.1:3008`. Open it in your browser for the **real Qwen Web UI** with auth injected.

## Architecture

```
Browser → HTTP (:3008) → Node.js Proxy → HTTPS → chat.qwen.ai
                          ├── /v1/*     → OpenAI-compatible API
                          ├── /api/*    → Proxied Qwen API (with JWT + source:desktop)
                          ├── /c/*      → Real Qwen SPA (HTML with auth injection)
                          ├── /api/v1/auths/*   → Mocked (fake "Qwen Slurp" user)
                          ├── /api/v2/auths/signin  → Proxy + save creds
                          └── /api/v2/auths/signout → Clear JWT + creds
```

## Two Interfaces

### 1. Qwen Web UI (default route `/`)
Serves the **real chat.qwen.ai SPA** with:
- JWT auth injected (auto-login from saved credentials)
- Auth routes mocked (`/api/v1/auths/`, `/api/v2/auths/`) — shows fake "Qwen Slurp" user instead of real account
- Login form works: `POST /api/v2/auths/signin` saves creds, `GET /api/v2/auths/signout` clears them
- Guest mode (no creds): SPA shows login screen, public config endpoints still proxied
- All API calls proxied with `source: desktop` header (Baxia bypass)
- **SSE toggle** button (bottom-right) to switch between streaming and buffered responses
- All thinking modes work (thinking, auto-thinking, search, etc.)
- Static assets (CSS, JS, fonts) loaded from upstream chat.qwen.ai

### 2. OpenAI API (`/v1/*`)
Standard OpenAI-compatible endpoints for programmatic clients:
- `GET /v1/models` — list models
- `POST /v1/chat/completions` — chat (stream + non-stream)
- Tool calls translated from Qwen's `function_call` to OpenAI's `tool_calls`

### 3. Simple Demo (`/demo`)
Lightweight chat UI with debug SSE logging.

## How It Works

### Authentication
Two credential formats accepted in config:
- **Plaintext**: `qwenLogin.password` — converted to SHA-256 at login time
- **Pre-hashed**: `qwenLogin.passwordHash` — used directly (SHA-256 hex string). Takes priority over `password`.

`POST https://chat.qwen.ai/api/v1/auths/signin` with `{ email, password: sha256(plaintext) }` → returns JWT `token` + cookies. Cached for 1 hour.

**Web UI login**: The SPA's login form calls `POST /api/v2/auths/signin` → proxy forwards to upstream, saves `passwordHash` to config, caches JWT, returns fake "Qwen Slurp" user. Signout (`GET /api/v2/auths/signout`) clears JWT + creds → guest mode (SPA shows login screen).

### Bypassing Baxia WAF
The `/api/v2/chat/completions` endpoint is protected by Alibaba Baxia anti-bot. We bypass it using:
- `source: desktop` header (the Qwen desktop app's API path)
- Desktop app User-Agent: `AliDesktop(QWENCHAT/1.0.3)`
- JWT Authorization header from the login step

### Chat Flow (API)
1. Login → get JWT + cookies
2. `POST /api/v2/chats/new` → create chat session, get `chat_id`
3. `POST /api/v2/chat/completions?chat_id=...` with `{ stream, version: "2.1", incremental_output: true, messages: [{ fid, role, content, ... }] }`
4. Parse SSE stream → OpenAI chunk format

### SSE Toggle
The injected toggle button sets `window.__qwenSseEnabled`. When disabled, the fetch interceptor converts `stream: true` to `stream: false` in chat completion requests, so the SPA gets a buffered response instead of SSE.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Qwen Web UI (real SPA) |
| GET | `/c/:chatId` | Qwen Web UI (specific chat) |
| GET | `/v1/models` | OpenAI: list models |
| POST | `/v1/chat/completions` | OpenAI: chat (stream supported) |
| GET | `/health` | Server status |
| GET | `/demo` | Simple chat demo |

## Supported Tools

The Qwen Web API uses **built-in tools only** — user-supplied tool definitions are not accepted. Tool calls are translated to OpenAI's `tool_calls` format.

| Tool | Description | SSE `phase` |
|------|-------------|-------------|
| `web_search` | Web search (auto-invoked for factual queries) | `web_search` |
| `image-generation` | Generate images from text (t2i mode) | `image_gen` |
| `code-interpreter` | Execute Python code | `code_interpreter` |
| `amap` | Maps and location search (Amap/高德) | `amap` |
| `fire-crawl` | Web page crawling and extraction | `fire_crawl` |

### Per-model capabilities
`thinking`, `search`, `vision`, `document`, `video`, `audio`, `citations`

### Chat types (modes)
`t2t` (text), `t2v` (video gen), `t2i` (image gen), `image_edit`, `search`, `artifacts`, `web_dev`, `deep_research`, `travel`, `learn`, `slides`, `mcp`

## Models

Fetched live from `https://chat.qwen.ai/api/models`. 23 models available including:
- **Qwen**: qwen3.7-plus, qwen3.7-max, qwen3.6-plus, qwen3.6-max-preview, qwen3.6-27b, qwen3.5-plus, qwen3.5-flash, qwen3.5-omni-plus, qwen3.5-omni-flash, qwen3.5-max-2026-03-08, qwen3-max-2026-01-23, qwen-plus-2025-07-28, qwen3-coder-plus, qwen3-vl-plus, qwen3-omni-flash-2025-12-01, qwen3.6-plus-preview
- **Open-source**: qwen3.5-397b-a17b, qwen3.5-122b-a10b, qwen3.5-27b, qwen3.5-35b-a3b, qwen3.6-35b-a3b

## Configuration

- `.config/config.json`:
  - `port` (3008)
  - `defaultModel` (`qwen3-coder-plus`)
  - `qwenLogin.email` — Qwen account email
  - `qwenLogin.password` — plaintext password (converted to SHA-256 at login time)
  - `qwenLogin.passwordHash` — pre-hashed password (SHA-256 hex, used directly). Takes priority over `password`.

## Key Files
- `src/server.js` — HTTP server, routes `/v1/*` to OpenAI API, everything else to webui
- `src/webui.js` — Reverse proxy for chat.qwen.ai SPA (HTML injection, auth, mock routes, SSE toggle)
- `src/chat.js` — OpenAI → Qwen chat completions translation (login, create chat, SSE parsing, tool call mapping)
- `src/models.js` — Model catalog (fetched from `/api/models`, static fallback)

## Known Issues
- **No user-supplied tools**: The API only uses its built-in tools. User-defined function tools in the request are ignored.
- **Thinking output**: Models with `thinking` capability include reasoning in `reasoning_content` field.
- **Chat sessions are ephemeral**: Each request creates a new chat session on chat.qwen.ai.
- **Guest mode blocked**: The qwen2api approach (guest + Baxia tokens) no longer works. The `source: desktop` + JWT approach is required.
- **Zero dependencies**: No npm packages needed — pure Node.js (uses built-in `fetch`).
