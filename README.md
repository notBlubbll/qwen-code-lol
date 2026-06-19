# Qwen Slurp

OpenAI-compatible proxy **+ full Qwen Web UI reverse proxy** for chat.qwen.ai. Serves the real Qwen SPA with JWT auth injected, mocks user routes, and exposes OpenAI-compatible `/v1/chat/completions`. Uses the desktop app's API path (`source: desktop`) to bypass the Alibaba Baxia WAF.

Pure Node.js (ESM). Runtime code uses only Node built-ins (`http`, `crypto`, `fs`, `path`, `url`, global `fetch`).

<img width="921" height="796" alt="image" src="https://github.com/user-attachments/assets/eb0995f4-1321-447c-9ab3-b873569829e9" />


## Quick Start

```bash
# 1. Configure credentials in .config/config.json
# 2. Start the proxy
node src/server.js
```

Runs on `http://127.0.0.1:3008`. Open it in your browser for the **real Qwen Web UI** with auth injected.

On Windows, use `start.cmd` to launch (kills stale process on port 3008, opens browser, starts server).

## Three Modes

### 1. Logged-in Mode (default)
When `qwenLogin` credentials are in config:
- Auto-logs in with real JWT from upstream
- Auth routes mocked with fake user built from real user data with `role: "user"` forced
- Full chat UI, all features working
- Login form also works: `POST /api/v2/auths/signin` saves creds, `GET /api/v2/auths/signout` clears them

### 2. ANON Mode (`"ANON": true` in config)
Full logged-in chat UI with a fake identity — looks like a real session but uses mock data:
- Fake JWT (valid base64url structure) injected into SPA
- Auth routes return fake "Anon" user with `role: "user"`
- All private API endpoints mocked (chats, folders, projects, settings, entitlement, notifications, etc.)
- **Chat still works** — upstream chat/completions + chat CRUD proxied with the real JWT from `qwenLogin` creds (forced login via `getJwt(true)`)
- "ANON" badge top-left, "Exit Anon" button bottom-right
- **Exit Anon** → server-side HTML page clears localStorage + cookies → redirects to `/auth` login page
- `_loggedOut` flag prevents auto-login until user explicitly signs in again
- `qwenLogin` creds preserved in config for upstream proxy calls

### 3. Guest Mode (no credentials)
No JWT, no auth mocks. SPA shows login screen. Public endpoints (configs, models, tts, users/status) still proxied without auth.

## Two Interfaces

### 1. Qwen Web UI (default route `/`)
Serves the **real chat.qwen.ai SPA** with:
- JWT auth injected (auto-login from saved credentials)
- `source: desktop` header on all API calls (replaces, not appends)
- **SSE toggle** button (bottom-right, purple) — switches between streaming and buffered responses
- **ANON mode** button (bottom-right, green/red) — toggles anonymous identity
- Cookie notice banner + account-pending overlay auto-removed via MutationObserver
- SSR content stripped to force `createRoot` (avoids React hydration mismatch)
- Inline scripts wrapped in try-catch (prevents null-reference crashes)
- All thinking modes work (thinking, auto-thinking, search, etc.)

### 2. OpenAI API (`/v1/*`)
Standard OpenAI-compatible endpoints for programmatic clients:
- `GET /v1/models` — list models
- `POST /v1/chat/completions` — chat (stream + non-stream)
- Tool calls translated from Qwen's `function_call` to OpenAI's `tool_calls`

> **Note**: `demo.html` exists at the repo root but **no route serves it**. To enable `/demo`, add a `GET /demo` handler in `server.js` or `webui.js` that reads and returns `demo.html`.

## How It Works

### Authentication
Two credential formats accepted in config:
- **Plaintext**: `qwenLogin.password` — converted to SHA-256 at login time
- **Pre-hashed**: `qwenLogin.passwordHash` — used directly (SHA-256 hex string). Takes priority over `password`.

`POST https://chat.qwen.ai/api/v1/auths/signin` with `{ email, password: sha256(plaintext) }` → returns JWT `token` + cookies. Cached for 1 hour.

**Web UI login flow**:
- `POST /api/v2/auths/signin` → proxies to upstream, saves `passwordHash` to config file, caches JWT, clears `_loggedOut`, returns fake user (real data with `role: "user"` forced)
- `GET /api/v2/auths/signout` → clears JWT cache + config creds, sets `_loggedOut` flag, returns success
- When no creds: guest mode (SPA shows login screen)

### ANON Mode Flow
1. `ANON: true` in config → fake JWT generated (valid base64url, SPA can decode without crashing)
2. HTML injection sets `Object.defineProperty(window, "__qwen_anon_mode", {value: true, writable: false, configurable: false})` in `<head>` before SPA loads
3. Auth routes return fake "Anon" user with the fake JWT
4. All private endpoints mocked with empty data shapes matching real API
5. Chat completions + chat CRUD (`chats/new`, specific chat ID PUT/DELETE) proxied with **real JWT** (`getJwt(true)` bypasses `_loggedOut`)
6. Exit Anon → `GET /api/anon-toggle?enable=false&redirect=1` → server-side HTML page clears localStorage/cookies, then `location.replace('/auth')`
7. `_loggedOut` flag prevents auto-login until user explicitly signs in again
8. `qwenLogin` creds preserved in config for upstream proxy calls

### Bypassing Baxia WAF
The `/api/v2/chat/completions` endpoint is protected by Alibaba Baxia anti-bot. We bypass it using:
- `source: desktop` header (the Qwen desktop app's API path)
- Desktop app User-Agent: `AliDesktop(QWENCHAT/1.0.3)`
- JWT Authorization header from the login step

**Critical**: The `source` header must REPLACE, not append. The SPA sets `source: web` — if the interceptor appends, upstream sees `web, desktop` which is rejected. Both `fetch()` and `XMLHttpRequest` interceptors override the header.

### HTML Patching
1. Add version marker (`<!-- QWEN-SLURP-V5 -->`)
2. Inject `__qwen_anon_mode` property in `<head>` (ANON mode only)
3. Strip SSR content from `#root` → forces `createRoot` instead of `hydrateRoot` (avoids React hydration mismatch)
4. Wrap inline scripts in try-catch (prevents null-reference crashes; skips `type=module`, `src=`, and `__prerendered_data` scripts)
5. Inject HEAD_INJECT_SCRIPT before `main.js`:
   - Patch `__prerendered_data.user.role` to `"user"`
   - Intercept `fetch()` — replace `source` header with `desktop`, SSE toggle logic
   - Intercept `XMLHttpRequest` — override `setRequestHeader` to replace `source` header, fallback set in `send()`
   - MutationObserver removes `.account-pending-overlay` and `[class*="cookie-confirm"]`, rewrites `<img>` CDN URLs to `/img` proxy (avoids `blocked_by_orb`)
6. Move after-`</body>` scripts inside `<body>`
7. Inject BODY_INJECT_SCRIPT — SSE toggle button, ANON mode button, ANON label

### Chat Flow (OpenAI API)
1. Login → get JWT + cookies
2. `POST /api/v2/chats/new` → create chat session, get `chat_id`
3. `POST /api/v2/chat/completions?chat_id=...` with `{ stream: true, version: "2.1", incremental_output: true, messages: [{ fid, role, content, feature_config, ... }] }`
4. Parse SSE stream → OpenAI chunk format

> **Note on message handling**: `chat.js` flattens the conversation into a single `[Role]: ...` text block. Only the last message's text is sent as the user `content`; prior turns are inlined as context text, not as separate structured messages.

`feature_config.thinking_enabled: true` is hardcoded — always on regardless of model capability or config.

### SSE Format
Qwen's SSE returns `data: {json}\n\n` lines. Each event has:
- `choices[0].delta.content` — text content
- `choices[0].delta.reasoning_content` — thinking content (via `extra.summary_thought` when `phase === "thinking_summary"`)
- `choices[0].delta.phase` — "answer", "thinking_summary", "web_search", "image_gen_tool"
- `choices[0].delta.function_call` — built-in tool calls (name + cumulative arguments)
- `choices[0].delta.role === "function"` — tool-result deltas (carry image URLs in `extra.tool_result[].image` and `extra.image_list[].image`)
- `choices[0].finish_reason` — null until "finished"
- `usage` — token counts (`input_tokens`, `output_tokens`, `total_tokens`)

`DeltaMapper` translates to OpenAI format: `delta.content`→`content`, reasoning→`reasoning_content` (cumulative, diffed), `delta.function_call`→`tool_calls` (cumulative args diffed per tool id). Tool-result deltas (`role: "function"`) have their image URLs extracted and emitted as `![image](url)` markdown content — search result text is skipped, but image URLs are forwarded. Non-streaming merges tool-call argument chunks by id.

### Logging
Console output (also written to `.logs/server.log`):
- Startup banner: mode + login email (if authenticated)
- `[req] POST /v1/chat/completions` — model, message count, stream flag (API path)
- `[req] prompt: <text>` — last user message text (API path)
- `[webui] prompt: <text>` — last user message text (Web UI path)
- `[chat] tool_call: <name>` / `[webui] tool_call: <name>` — tool name, logged once per tool when first detected

### SSE Toggle
The injected toggle button sets `window.__qwenSseEnabled`. When disabled, the fetch interceptor converts `stream: true` to `stream: false` in chat completion requests, so the SPA gets a buffered response instead of SSE.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Qwen Web UI (real SPA) |
| GET | `/c/:chatId` | Qwen Web UI (specific chat) |
| GET | `/auth` | Login page |
| GET | `/authorize` | OAuth authorize page |
| GET | `/v1/models` | OpenAI: list models |
| POST | `/v1/chat/completions` | OpenAI: chat (stream supported) |
| GET | `/health` | Server status |
| GET | `/img?url=<cdn-url>` | Image proxy — fetches Qwen CDN images with desktop headers (avoids `blocked_by_orb`) |
| POST/GET | `/api/anon-toggle?enable=true\|false&redirect=1` | Toggle ANON mode |
| POST | `/api/v2/auths/signin` | Proxy login + save creds |
| GET | `/api/v2/auths/signout` | Clear JWT + creds + set `_loggedOut` |

## Supported Tools

The Qwen Web API uses **built-in tools only** — user-supplied tool/function definitions in requests are ignored. Tool calls are automatically invoked by Qwen and translated to OpenAI's `tool_calls` format in the response. Tool execution is server-side at chat.qwen.ai (our proxy does not execute tools).

| Tool | API name | Description |
|------|----------|-------------|
| Web search | `web_search` | Web search (auto-invoked for factual/recent queries) |
| Image generation | `image_gen` | Generate images from text prompts — result URLs proxied via `/img` and emitted as `![image](url)` markdown in content |
| Code interpreter | `code-interpreter` | Execute Python code in a sandbox |
| Maps | `amap` | Maps and location search (Amap/高德) |
| Fire crawl | `fire-crawl` | Web page crawling and extraction |

Each tool name is logged once per request when first detected (`[chat] tool_call: <name>` or `[webui] tool_call: <name>`).

## Models

Fetched live from `https://chat.qwen.ai/api/models` (public endpoint, no auth, 5-min cache). Falls back to a static catalog of **20 models** on fetch failure. Models are resolved case-insensitively.

| Model | Context | Thinking | Vision |
|-------|---------|----------|--------|
| `qwen3.7-plus` | 1,000,000 | ✔ | ✔ |
| `qwen3.7-max` | 1,000,000 | ✔ | — |
| `qwen3.6-plus` | 1,000,000 | ✔ | ✔ |
| `qwen3.6-plus-preview` | 1,000,000 | ✔ | ✔ |
| `qwen3.6-max-preview` | 1,000,000 | ✔ | — |
| `qwen3.6-27b` | 131,072 | — | — |
| `qwen3.5-plus` | 1,000,000 | ✔ | ✔ |
| `qwen3.5-flash` | 1,000,000 | ✔ | — |
| `qwen3.5-max-2026-03-08` | 1,000,000 | ✔ | — |
| `qwen3.5-omni-plus` | 1,000,000 | ✔ | ✔ |
| `qwen3.5-omni-flash` | 1,000,000 | ✔ | ✔ |
| `qwen3.5-27b` | 131,072 | — | — |
| `qwen3.5-35b-a3b` | 131,072 | — | — |
| `qwen3.5-397b-a17b` | 131,072 | — | — |
| `qwen3.5-122b-a10b` | 131,072 | — | — |
| `qwen3-max-2026-01-23` | 262,144 | ✔ | — |
| `qwen3-coder-plus` | 1,000,000 | — | — |
| `qwen3-vl-plus` | 131,072 | — | ✔ |
| `qwen3-omni-flash-2025-12-01` | 131,072 | ✔ | ✔ |
| `qwen-plus-2025-07-28` | 131,072 | — | — |

All models are `tier: free`. Default model is `qwen3-coder-plus` (configurable via `defaultModel`).

> **Note**: `feature_config.thinking_enabled` is hardcoded `true` in the chat request builder, so thinking output is always sent for models that support it (shown in `reasoning_content`). Models without thinking capability ignore this flag.

## Configuration

`.config/config.json`:

| Key | Default | Description |
|-----|---------|-------------|
| `port` | `3008` | HTTP server port |
| `defaultModel` | `qwen3-coder-plus` | Fallback model for API requests |
| `ANON` | `false` | Enable ANON mode (full chat UI with fake identity) |
| `qwenLogin.email` | — | Qwen account email |
| `qwenLogin.password` | — | Plaintext password (converted to SHA-256 at login) |
| `qwenLogin.passwordHash` | — | Pre-hashed SHA-256 hex (takes priority over `password`) |

> **Unused keys**: `enableThinking` and `enableCacheControl` are present in the shipped config but never read by any code. `thinking_enabled` is hardcoded `true` in the chat request builder.

## Architecture

```
Browser/Client → HTTP (:3008) → Node.js Proxy
                  ├── /v1/models            → listModels() (src/models.js)
                  ├── /v1/chat/completions  → handleChatCompletion (src/chat.js)
                  ├── /health               → { status: "ok" }
                  ├── /img?url=<cdn-url>    → image proxy (desktop UA + referer)
                  └── everything else       → handleWebUI (src/webui.js)
                       ├── /api/v2/auths/signin   → Proxy + save creds + fake user
                       ├── /api/v2/auths/signout  → Clear JWT + creds + set _loggedOut
                       ├── /api/anon-toggle       → Toggle ANON mode
                       ├── / , /c/* , /auth , /authorize → serveHtml (patched SPA)
                       ├── /api/* (mocked in ANON) → findMockRoute
                       └── /api/* + GET fallback   → proxyToUpstream
                            ↑ source: desktop + Bearer {JWT} + desktop UA
```

## Key Files
- `src/server.js` — HTTP server (port 3008). Routes `/v1/*` to OpenAI API, everything else to webui proxy. Sets up `.logs/server.log` file logging.
- `src/webui.js` — Reverse proxy for chat.qwen.ai SPA. Handles three modes (logged-in, ANON, guest). HTML injection, auth, mock routes, SSE toggle, ANON button.
- `src/chat.js` — OpenAI → Qwen chat completions translation (login, create chat, SSE parsing, tool call mapping). Flattens message history into one text block.
- `src/models.js` — Model catalog (fetched from `/api/models`, static fallback with 20 models, 5-min cache).
- `demo.html` — Standalone chat demo with debug SSE logging. **Not served by any route.**
- `start.cmd` — Windows launcher: kills stale process on port 3008, cleans `nul` file, opens browser, starts server.
- `.config/config.json` — Runtime config.

## Known Issues
- **`/demo` route not implemented**: `demo.html` exists but no route serves it. Add a `GET /demo` handler to enable.
- **Unused `playwright` dependency**: `package.json` lists `playwright` but no source file imports it. Safe to remove.
- **Unused config keys**: `enableThinking` and `enableCacheControl` are never read. `thinking_enabled` is hardcoded `true`.
- **Message flattening**: `chat.js` concatenates all prior turns into one `[Role]: ...` text block instead of sending structured multi-turn messages. Loses native turn structure.
- **Hard fallback model mismatch**: falls back to `qwen3.7-plus` if both requested and `defaultModel` fail, even though `defaultModel` is `qwen3-coder-plus`.
- **Unused import**: `chat.js` imports `MODELS` but never uses it (only `resolveModel` is used).
- **No user-supplied tools**: The API only uses its built-in tools. User-defined function tools in requests are ignored.
- **Chat sessions are ephemeral**: Each request creates a new chat session on chat.qwen.ai.
- **Guest mode (Baxia) blocked**: The qwen2api approach (guest + Baxia tokens) no longer works. `source: desktop` + JWT is required.
- **SPA reload loop**: In some edge cases the SPA may reload multiple times before stabilizing. `#root` stripping + try-catch wrapping mitigates most crashes.
- **`Object.assign` bug**: `Object.assign(_config, cfg)` does NOT delete removed keys. Always use `applyConfig(cfg)` (used in `webui.js`) which deletes keys not in `cfg` before assigning.
- **`source` header append vs replace**: `XMLHttpRequest.setRequestHeader()` APPENDS headers. The XHR interceptor overrides `setRequestHeader` to intercept `source` and replace it, plus a fallback in `send()`.
