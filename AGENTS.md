# Qwen Slurp — Agent Notes

## What It Does
OpenAI-compatible proxy **+ full Qwen Web UI reverse proxy** for chat.qwen.ai. Serves the real Qwen SPA with JWT auth injected, mocks user routes, and provides an OpenAI-compatible `/v1/chat/completions` endpoint. Uses the `source: desktop` header to bypass the Alibaba Baxia WAF.

Pure Node.js (ESM). The only third-party dependency in `package.json` (`playwright`) is **not imported by any source file** — all runtime code uses Node built-ins only (`http`, `crypto`, `fs`, `path`, `url`, global `fetch`).

## Key Files
- `src/server.js` — HTTP server (port 3008). Routes `/v1/models`, `/v1/chat/completions`, `/health` locally; everything else → `handleWebUI`. Also sets up `.logs/server.log` file logging by overriding `console.log`/`console.error`.
- `src/webui.js` — Reverse proxy for chat.qwen.ai SPA. Handles three modes (logged-in, ANON, guest). Injects HTML patches (auth, fetch/XHR interceptors, SSE toggle, ANON button, cookie/banner removal). Mocks auth routes and private APIs in ANON mode. Proxies all API calls with `source: desktop` (replaces, not appends).
- `src/chat.js` — OpenAI → Qwen chat completions. Login (SHA-256), create chat session, send message with `fid` format, parse SSE → OpenAI format. Tool calls (`function_call` → `tool_calls`) translated. Flattens message history into a single `[Role]: ...` text block.
- `src/models.js` — Model catalog (fetched from `/api/models`, static fallback with **20 models**, 5-min cache).
- `start.cmd` — Windows launcher: kills stale process on port 3008, cleans `nul` file, opens browser, starts server.
- `.config/config.json` — Runtime config (see Config section).

## How It Works

### Request Routing (server.js)
`handleRequest` is the single entry point:
1. `OPTIONS` → CORS preflight (204)
2. `GET /v1/models` → `listModels()`
3. `POST /v1/chat/completions` → `handleChatCompletion(body)` (stream or collect)
4. `GET /health` → `{ status: "ok" }`
5. **Everything else** → `handleWebUI(req, res, url)`

Note: `server.js`'s `loadConfig()` only reads `port`, `defaultModel`, `qwenLogin`. The `ANON` flag and other keys are read by `webui.js`/`chat.js`, which each load the config file independently from `.config/config.json`.

### Three Modes (webui.js)

**Logged-in mode** (default, `qwenLogin` creds in config):
- Auto-logs in with real JWT from upstream
- Auth routes mocked with fake user built from real user data with `role: "user"` forced
- Full chat UI, all features working

**ANON mode** (`ANON: true` in config) — **cosmetic anonymity only, not truly anonymous**:
- Full logged-in chat UI with fake identity — looks like a real session
- Fake JWT (valid base64url structure, SPA can decode without crashing)
- Auth routes return fake "Anon" user
- All private API endpoints (chat list, folders, projects, settings, notifications, etc.) mocked with empty data
- **Chat messages are NOT anonymous** — they are proxied to the real upstream account using `qwenLogin` creds (`getJwt(true)` forced login). Each message creates a real chat session on the real account.
- **No chat history visible** — the chat list (`GET /api/v2/chats`) is mocked empty, so the SPA shows no past conversations. Chats created during an ANON session are invisible in the UI but exist on the real account.
- Opening a past chat by ID (`/c/{id}`) loads the SPA, but the SPA cannot list or find chats since the list endpoint returns `[]`.
- Without `qwenLogin` creds in config, chat returns **401** (ANON mode requires real credentials for upstream chat calls).
- "ANON" badge top-left, "Exit Anon" button bottom-right
- Exit Anon → redirect page clears localStorage/cookies → `/auth` login page
- `_loggedOut` flag prevents auto-login until explicit sign-in
- `qwenLogin` creds preserved in config for upstream API calls
- **Summary**: ANON mode = real account's chat capability + fake identity in UI + no chat history visible. It is not a guest/no-login mode.

**Guest mode** (no creds):
- No JWT, no auth mocks
- SPA shows login screen
- Public endpoints proxied without auth

### Authentication
Two credential formats accepted in config:
- **Plaintext**: `qwenLogin.password` — converted to SHA-256 at login time
- **Pre-hashed**: `qwenLogin.passwordHash` — used directly (SHA-256 hex string). Takes priority over `password`.

`POST https://chat.qwen.ai/api/v1/auths/signin` with `{ email, password: sha256(plaintext) }` → returns JWT `token` + cookies. The JWT is cached for 1 hour (`_jwtExpiry = Date.now() + 3600*1000`).

**Web UI login flow**:
- `POST /api/v2/auths/signin` → `handleSignin`: proxies to upstream, saves `passwordHash` to config file, caches JWT, clears `_loggedOut`, returns fake user (real user data with `role: "user"`)
- `GET /api/v2/auths/signout` → `handleSignout`: clears JWT cache + config creds, sets `_loggedOut` flag, returns success
- When no creds: guest mode (SPA shows login screen). Public endpoints proxied without auth.

### ANON Mode Internals
- `generateFakeJwt()` — creates JWT with valid base64url header/payload/signature (SPA can `atob()` the payload without errors). Signature is a dummy base64url string.
- `_loggedOut` flag — prevents `getJwt()` from auto-logging in after Exit Anon. Cleared on explicit sign-in or ANON enable.
- `getJwt(forceLogin)` — `forceLogin=true` bypasses `_loggedOut`, used for ANON mode upstream chat calls.
- `applyConfig(cfg)` — replaces `_config` contents properly (deletes removed keys). `Object.assign` does NOT delete keys, which caused `_config.ANON` to persist after Exit Anon. **Always use `applyConfig(cfg)`**, never `Object.assign(_config, cfg)`.
- `handleAnonToggle(res, enable, redirect)` — when `redirect=1 && !enable`, returns HTML page that clears localStorage/cookies then redirects to `/auth`.
- `findMockRoute(pathname)` — ANON mode: mocks auth routes, private endpoints (chats, folders, projects, settings, entitlement, notifications, etc.), catch-all for unknown `/api/` routes. Passes through public APIs (configs, models, tts, users/status) and chat CRUD (with real JWT).

### Bypassing Baxia WAF
The chat completions endpoint (`/api/v2/chat/completions`) is protected by Alibaba Baxia anti-bot. We bypass it using:
- `source: desktop` header (the Qwen desktop app's API path)
- Desktop app User-Agent: `Mozilla/5.0 ... AliDesktop(QWENCHAT/1.0.3)`
- JWT Authorization header from the login step

**Critical**: The `source` header must REPLACE, not append. The SPA sets `source: web` — if our interceptor appends, upstream sees `web, desktop` which is rejected. Both `fetch()` and `XMLHttpRequest` interceptors override the header.

### HTML Patching (patchHtml)
1. Add version marker (`<!-- QWEN-SLURP-V5 -->`)
2. Inject `Object.defineProperty(window, "__qwen_anon_mode", {value: true, writable: false, configurable: false})` in `<head>` (before SPA loads, survives SPA re-renders) — only in ANON mode
3. Strip SSR content from `#root` → forces `createRoot` instead of `hydrateRoot` (avoids React hydration mismatch #418)
4. Wrap inline scripts in try-catch (prevents `Cannot set properties of null` from AES tracker crashing React error boundary). Skips `type=module`, `src=`, and `__prerendered_data` scripts.
5. Inject HEAD_INJECT_SCRIPT before `main.js`:
   - Patch `__prerendered_data.user.role` to `"user"`
   - Intercept `fetch()` — replace `source` header with `desktop`, SSE toggle logic
   - Intercept `XMLHttpRequest` — override `setRequestHeader` to replace `source` header, fallback set in `send()`
   - MutationObserver removes `.account-pending-overlay` and `[class*="cookie-confirm"]`
6. Move after-`</body>` scripts inside `<body>`
7. Inject BODY_INJECT_SCRIPT — SSE toggle button, ANON mode button, ANON label

### Chat Flow (OpenAI API — chat.js)
1. `login()` → reloads config, hashes password (if plaintext), `POST /api/v1/auths/signin` → JWT + cookies (cached 1h)
2. `parseIncomingMessages(messages)` → **flattens** the whole conversation into one string: history joined as `[User]: ... [Assistant]: ... [System]: ...`, then `[User]: <last>` appended. Only the last message's text is sent as the user `content`; prior turns are inlined as context text, NOT as separate structured messages.
3. `createChatSession` → `POST /api/v2/chats/new` with `{ chat: { title: "New chat" } }` → returns `chat_id`
4. `buildChatRequest(chatId, model, content)` → `POST /api/v2/chat/completions?chat_id=...` with:
   - `stream: true`, `version: "2.1"`, `incremental_output: true`, `chat_mode: "t2t"`
   - Single message: `{ fid, parentId: null, childrenIds: [], role: "user", content, user_action: "send", models: [model], chat_type: "t2t", feature_config, extra, sub_chat_type: "t2t" }`
   - `feature_config.thinking_enabled: true` is **hardcoded** — always on regardless of model capability or config. Other feature flags: `output_schema: "phase"`, `research_mode: "normal"`, `auto_thinking: true`, `thinking_mode: "Auto"`, `thinking_format: "summary"`, `auto_search: false`.
5. Parse SSE stream → OpenAI chunk format (`streamChat` async generator) or collect into one response (`collectChat`)

Model resolution chain: `resolveModel(requestedModel) || resolveModel(_config.defaultModel) || 'qwen3.7-plus'`. Note the hard fallback is `qwen3.7-plus` even though `defaultModel` is `qwen3-coder-plus` in the shipped config.

### SSE Format
Qwen's SSE returns `data: {json}\n\n` lines. Each event has:
- `choices[0].delta.content` — text content
- `choices[0].delta.reasoning_content` — thinking content (via `extra.summary_thought` when `phase === "thinking_summary"`)
- `choices[0].delta.phase` — "answer", "thinking_summary", "web_search"
- `choices[0].delta.function_call` — built-in tool calls (name + arguments)
- `choices[0].finish_reason` — null until "finished"
- `usage` — token counts (`input_tokens`, `output_tokens`, `total_tokens`)

`mapUpstreamDeltaToOpenAI` translates: `delta.content`→`content`, reasoning→`reasoning_content`, `delta.function_call`→`tool_calls` (with generated `call_` id if no `function_id`). Deltas with `role: "function"` (tool results) are skipped in streaming. Non-streaming merges tool-call argument chunks by id. `usage` mapped to `prompt_tokens`/`completion_tokens`/`total_tokens`.

`extractReasoningContentFromDelta`: prefers `delta.reasoning_content`/`delta.reasoning`; falls back to `delta.extra.summary_thought.content` (array joined by `\n`) only when `phase === "thinking_summary"`.

### Models (models.js)
- `MODELS` — static object, **20 models** with `contextSize`, `enableThinking`, `vision`, `tier` metadata
- `resolveModel(name)` — case-insensitive lookup via a `Map`
- `listModels()` — fetches `GET /api/models` (public, no auth), maps to `{ id, name, object: "model", created, owned_by: "qwen" }`, caches 5 min (`CACHE_TTL`). Falls back to static list on failure.

### WebUI Proxying (webui.js)
- `proxyToUpstream` — sets `source: desktop`, `authorization: Bearer {jwt}`, `cookie`, desktop UA, `referer`, `x-request-id`. For SSE paths (`/chat/completions`), sets `X-Accel-Buffering: no` and streams the response body through. Otherwise buffers and forwards with the upstream content-type.
- `serveHtml` — fetches SPA HTML from upstream, runs `patchHtml`, sets `token={jwt}` cookie (1h expiry) when a JWT is present, no-cache headers.
- HTML pages served: `/`, `/c/*`, `/auth`, `/authorize`.
- ANON mode API routing: chat completions + `chats/new` + specific chat ID (PUT/DELETE) use **real JWT** (`getJwt(true)`); everything else proxied without auth (guest). If no real creds → 401.
- Non-ANON: public APIs (`/api/v2/configs`, `/api/v2/tts/`, `/api/v2/users/status`, `/api/v2/models`, `/api/models`) proxy without JWT; everything else requires JWT or 401.

## Supported Tools
Built-in only (no user-supplied tools). User-defined function tools in requests are ignored.
- `web_search` — auto web search
- `image-generation` — text-to-image
- `code-interpreter` — Python execution
- `amap` — maps/location
- `fire-crawl` — web crawling

Tool calls translated from Qwen `function_call` → OpenAI `tool_calls` format.

## Config
`.config/config.json`. Keys **actually read by code**:
- `port` (server.js, default 3008)
- `defaultModel` (server.js + chat.js, default `qwen3-coder-plus`)
- `ANON` (webui.js — enables ANON mode)
- `qwenLogin.email` (webui.js + chat.js)
- `qwenLogin.password` — plaintext (converted to SHA-256 at login)
- `qwenLogin.passwordHash` — pre-hashed SHA-256 hex, takes priority over `password`

Keys present in the shipped config but **NOT read by any code** (no-op):
- `enableThinking`
- `enableCacheControl`

## Architecture
```
Browser/Client → HTTP (:3008) → Node.js Proxy
                  ├── /v1/models            → listModels() (src/models.js)
                  ├── /v1/chat/completions  → handleChatCompletion (src/chat.js)
                  ├── /health               → { status: "ok" }
                  └── everything else       → handleWebUI (src/webui.js)
                       ├── /api/v2/auths/signin   → Proxy + save creds + fake user
                       ├── /api/v2/auths/signout  → Clear JWT + creds + set _loggedOut
                       ├── /api/anon-toggle       → Toggle ANON mode
                       ├── / , /c/* , /auth , /authorize → serveHtml (patched SPA)
                       ├── /api/* (mocked in ANON) → findMockRoute
                       └── /api/* + GET fallback   → proxyToUpstream
                            ↑ source: desktop + Bearer {JWT} + desktop UA
```

## Known Issues & Gotchas
- **Unused `playwright` dependency**: `package.json` lists `playwright` but no source file imports it. Safe to remove from dependencies (runtime is zero-dep; built-in `fetch` only).
- **Unused config keys**: `enableThinking` and `enableCacheControl` in `.config/config.json` are never read. `thinking_enabled` is hardcoded `true` in `buildChatRequest`.
- **Message flattening**: `chat.js` does not send multi-turn structured messages upstream. It concatenates all prior turns into one `[Role]: ...` text block and sends a single user message. This loses native turn structure but works for context.
- **Hard fallback model mismatch**: `chat.js` falls back to `qwen3.7-plus` if both requested and `defaultModel` fail to resolve, even though `defaultModel` is `qwen3-coder-plus`.
- **Unused import**: `chat.js` imports `MODELS` from `models.js` but never references it (only `resolveModel` is used).
- **Thinking output**: models with thinking capability include reasoning in `reasoning_content`.
- **Guest mode (Baxia) blocked**: the qwen2api approach (guest + Baxia tokens) no longer works. `source: desktop` + JWT is required.
- **Chat sessions are ephemeral**: each request creates a new chat session on chat.qwen.ai.
- **SPA reload loop**: in some edge cases the SPA may reload multiple times before stabilizing. `#root` stripping + try-catch wrapping mitigates most crashes.
- **`Object.assign` bug**: `Object.assign(_config, cfg)` does NOT delete removed keys. Always use `applyConfig(cfg)` which deletes keys not in `cfg` before assigning.
- **`source` header append vs replace**: `XMLHttpRequest.setRequestHeader()` APPENDS headers. The XHR interceptor overrides `setRequestHeader` to intercept `source` and replace it, plus a fallback in `send()`.
- **Config loaded in 3 places**: `server.js`, `webui.js`, and `chat.js` each call their own `loadConfig()` against the same file. `chat.js` reloads on every login attempt (so Web UI credential updates are picked up); `webui.js` keeps `_config` in memory and only updates it via `applyConfig` on signin/signout/anon-toggle.
- **`nul` file cleanup**: Git Bash on Windows can create a literal `nul` file. `server.js` and `start.cmd` delete it on startup; `package.json` `prestart`/`preinstall` scripts also clean it (and `package-lock.json`).
