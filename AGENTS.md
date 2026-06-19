# Qwen Slurp — Agent Notes

## What It Does
OpenAI-compatible proxy **+ full Qwen Web UI reverse proxy** for chat.qwen.ai. Serves the real Qwen SPA with JWT auth injected, mocks user routes, and provides OpenAI-compatible `/v1/chat/completions` endpoint. Uses `source: desktop` header to bypass Alibaba Baxia WAF.

## Key Files
- `src/server.js` — HTTP server (port 3008). Routes `/v1/*` to OpenAI API, everything else to webui proxy.
- `src/webui.js` — Reverse proxy for chat.qwen.ai SPA. Injects JWT auth, mocks auth routes (`/api/v1/auths/`, `/api/v2/auths/`) returning fake "Qwen Slurp" user, handles signin/signout, injects SSE toggle button, proxies all API calls with `source: desktop`.
- `src/chat.js` — OpenAI → Qwen chat completions. Login (SHA-256), create chat session, send message with `fid` format, parse SSE → OpenAI format. Tool calls (`function_call` → `tool_calls`) translated.
- `src/models.js` — Model catalog (fetched from `/api/models`, static fallback with 20 models).
- `demo.html` — Simple chat demo with debug SSE logging.

## How It Works

### Authentication
Two credential formats accepted in config:
- **Plaintext**: `qwenLogin.password` — converted to SHA-256 at login time
- **Pre-hashed**: `qwenLogin.passwordHash` — used directly (SHA-256 hex string)

`POST https://chat.qwen.ai/api/v1/auths/signin` with `{ email, password: sha256(plaintext) }` → returns JWT `token` + cookies. The JWT is cached for 1 hour.

**Web UI login flow**:
- `POST /api/v2/auths/signin` → proxies to upstream, saves `passwordHash` to config, caches JWT, returns fake "Qwen Slurp" user
- `GET /api/v2/auths/signout` → clears JWT cache + config creds, returns success
- When no creds: guest mode (SPA shows login screen). Config endpoints (`/api/v2/configs/*`, `/api/v2/tts/*`, `/api/v2/users/status`) are public and proxied without auth.

### Bypassing Baxia WAF
The chat completions endpoint (`/api/v2/chat/completions`) is protected by Alibaba Baxia anti-bot. We bypass it using:
- `source: desktop` header (the Qwen desktop app's API path)
- Desktop app User-Agent: `AliDesktop(QWENCHAT/1.0.3)`
- JWT Authorization header from the login step

This combination makes the server treat requests as coming from the Qwen desktop app, which is not subject to the web BX challenge.

### Web UI Reverse Proxy
1. Browser requests `/` → proxy fetches HTML from chat.qwen.ai
2. Injects `<script>` before main.js that:
   - Patches `__prerendered_data.user.role` to `"user"` (bypasses account-pending overlay)
   - Intercepts `fetch()` and XHR to set `source: desktop` header (replace, not append)
   - Adds SSE toggle button (bottom-right, purple)
   - When SSE is off, converts `stream: true` to `stream: false` in chat requests
   - MutationObserver safety net removes `.account-pending-overlay` if it appears
3. Auth routes (`/api/v1/auths/`, `/api/v2/auths/`) return fake "Qwen Slurp" user with `role: "user"`
4. All other `/api/*` routes proxied to upstream with JWT + `source: desktop`
5. Static assets (CSS/JS from `assets.alicdn.com`) loaded directly from CDN

### Chat Flow (OpenAI API)
1. Login → get JWT + cookies
2. `POST /api/v2/chats/new` → create chat session, get `chat_id`
3. `POST /api/v2/chat/completions?chat_id=...` with:
   - `stream: true`, `version: "2.1"`, `incremental_output: true`
   - Message format: `{ fid, parentId, childrenIds, role, content, user_action, models, chat_type, feature_config, extra, sub_chat_type }`
   - `feature_config.thinking_enabled: true` enables reasoning output
4. Parse SSE stream → OpenAI chunk format

### SSE Format
Qwen's SSE returns `data: {json}\n\n` lines. Each event has:
- `choices[0].delta.content` — text content
- `choices[0].delta.reasoning_content` — thinking content (via `extra.summary_thought`)
- `choices[0].delta.phase` — "answer", "thinking_summary", "web_search"
- `choices[0].delta.function_call` — built-in tool calls (name + arguments)
- `choices[0].finish_reason` — null until "finished"
- `usage` — token counts

## Supported Tools
Built-in only (no user-supplied tools):
- `web_search` — auto web search
- `image-generation` — text-to-image
- `code-interpreter` — Python execution
- `amap` — maps/location
- `fire-crawl` — web crawling

Tool calls translated from Qwen `function_call` → OpenAI `tool_calls` format.

## Config
- `.config/config.json`:
  - `port` (3008)
  - `defaultModel` (`qwen3-coder-plus`)
  - `qwenLogin.email` — Qwen account email
  - `qwenLogin.password` — plaintext password (converted to SHA-256 at login time)
  - `qwenLogin.passwordHash` — pre-hashed password (SHA-256 hex, used directly). Takes priority over `password`.

## Architecture
```
Browser/Client → HTTP (:3008) → Node.js Proxy
                  ├── /v1/*     → OpenAI API (src/chat.js)
                  ├── /api/*    → Proxied to chat.qwen.ai (src/webui.js)
                  │              ↑ source: desktop + Bearer {JWT}
                  ├── /c/*      → Real Qwen SPA HTML (with auth injection)
                  ├── /api/v1/auths/*  → Mocked (fake "Qwen Slurp" user)
                  ├── /api/v2/auths/signin  → Proxy + save creds
                  ├── /api/v2/auths/signout → Clear JWT + creds
                  └── /demo     → Simple chat demo
```

## Known Issues
- **Thinking output**: qwen3.7-plus includes reasoning content in `reasoning_content` field.
- **Guest mode (Baxia) blocked**: The qwen2api approach (guest + Baxia tokens) no longer works. The `source: desktop` + JWT approach is required.
- **No user-supplied tools**: The API only uses built-in tools.
- **Chat sessions are ephemeral**: Each request creates a new chat session on chat.qwen.ai.
- **Zero dependencies**: Pure Node.js, no npm packages.
