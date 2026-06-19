/**
 * Reverse proxy for the Qwen Web UI (chat.qwen.ai).
 *
 * Serves the real SPA HTML/CSS/JS, injects our JWT auth token so the
 * UI thinks it's logged in, mocks user routes with a fake "Qwen Slurp"
 * user, and proxies all API calls with source:desktop + Bearer JWT.
 *
 * An SSE toggle button is injected to switch between streaming and
 * buffered responses.
 */

import { createHash, randomUUID } from 'crypto';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPSTREAM = 'https://chat.qwen.ai';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 AliDesktop(QWENCHAT/1.0.3)';

// ─── Config ───────────────────────────────────────────────────

function loadConfig() {
  const cfgPath = join(__dirname, '../.config/config.json');
  if (existsSync(cfgPath)) {
    try { return JSON.parse(readFileSync(cfgPath, 'utf8')); } catch {}
  }
  return {};
}
function saveConfig(cfg) {
  const cfgPath = join(__dirname, '../.config/config.json');
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}
const _config = loadConfig();

// ─── Fake user (shown in SPA instead of real account) ──────────
// In ANON mode: returns fake "Qwen Slurp" user
// In normal mode: returns real user data with role forced to "user"

function getFakeUser(realUser = null) {
  const base = realUser || _user;
  // In ANON mode, always return fake user
  if (_config.ANON && !base) {
    return {
      id: randomUUID(),
      email: 'slurp@qwen.ai',
      name: 'Qwen Slurp',
      role: 'user',
      profile_image_url: '',
      tier: '',
      token: '',
      token_type: 'Bearer',
      expires_at: Math.floor((Date.now() + 3600 * 1000) / 1000),
      permissions: {
        workspace: { models: false, knowledge: false, prompts: false, tools: false },
        chat: { file_upload: true, delete: true, edit: true, temporary: true },
      },
    };
  }
  // In normal mode, return real user data with role forced to "user"
  return {
    id: base?.id || randomUUID(),
    email: base?.email || 'unknown@qwen.ai',
    name: base?.name || 'Qwen User',
    role: 'user', // force "user" to bypass account-pending overlay
    profile_image_url: base?.profile_image_url || '',
    tier: base?.tier || '',
    token: base?.token || _jwt || '',
    token_type: 'Bearer',
    expires_at: base?.expires_at || Math.floor((Date.now() + 3600 * 1000) / 1000),
    permissions: base?.permissions || {
      workspace: { models: false, knowledge: false, prompts: false, tools: false },
      chat: { file_upload: true, delete: true, edit: true, temporary: true },
    },
  };
}

// ─── Login (cached JWT) ──────────────────────────────────────

let _jwt = null;
let _cookies = null;
let _jwtExpiry = 0;
let _user = null;

async function getJwt() {
  // ANON mode: return fake user without upstream login
  if (_config.ANON) {
    if (!_jwt) {
      _jwt = 'anon-demo-mode';
      _jwtExpiry = Date.now() + 365 * 24 * 3600 * 1000;
      _user = getFakeUser();
    }
    return { jwt: null, cookies: '', user: _user }; // jwt=null so we don't send Bearer to upstream
  }

  if (_jwt && _jwt !== 'anon-demo-mode' && Date.now() < _jwtExpiry) {
    return { jwt: _jwt, cookies: _cookies, user: _user };
  }

  const { email, password, passwordHash } = _config.qwenLogin || {};
  if (!email || (!password && !passwordHash)) return null; // guest mode — no creds

  // Hash plaintext if available; otherwise use stored hash directly
  const hash = password
    ? createHash('sha256').update(password, 'utf8').digest('hex')
    : passwordHash;
  const resp = await fetch(`${UPSTREAM}/api/v1/auths/signin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'source': 'desktop',
      'User-Agent': DESKTOP_UA,
      'Accept': 'application/json',
      'Origin': UPSTREAM,
      'Referer': UPSTREAM + '/',
    },
    body: JSON.stringify({ email, password: hash }),
  });
  if (!resp.ok) throw new Error(`Login failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.token) throw new Error('Login failed: no token');

  _jwt = data.token;
  _cookies = (resp.headers.getSetCookie() || []).map(c => c.split(';')[0]).join('; ');
  _user = data;
  _jwtExpiry = Date.now() + 3600 * 1000;
  console.log(`[webui] Logged in as ${_user.email}`);
  return { jwt: _jwt, cookies: _cookies, user: _user };
}

function clearJwt() {
  _jwt = null;
  _cookies = null;
  _user = null;
  _jwtExpiry = 0;
  console.log('[webui] JWT cleared (logout)');
}

// Handle SPA signin: proxy to upstream, save creds, return fake user
async function handleSignin(req, res, body) {
  try {
    const { email, password } = JSON.parse(body);
    // The SPA sends a SHA-256 hashed password. Save creds so getJwt() can
    // reuse them for JWT refresh. Store as passwordHash.
    if (email && password) {
      const newCfg = { ..._config, qwenLogin: { email, passwordHash: password } };
      saveConfig(newCfg);
      Object.assign(_config, newCfg);
      console.log(`[webui] Saved credentials for ${email}`);
    }

    // Login to upstream — password is already hashed, send as-is
    const resp = await fetch(`${UPSTREAM}/api/v1/auths/signin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'source': 'desktop',
        'User-Agent': DESKTOP_UA,
        'Accept': 'application/json',
        'Origin': UPSTREAM,
        'Referer': UPSTREAM + '/',
      },
      body: JSON.stringify({ email, password }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      res.writeHead(resp.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ success: false, data: { code: 'ERR_AUTH', details: errText.slice(0, 200) } }));
    }

    const realUser = await resp.json();
    _jwt = realUser.token;
    _cookies = (resp.headers.getSetCookie() || []).map(c => c.split(';')[0]).join('; ');
    _user = realUser;
    _jwtExpiry = Date.now() + 3600 * 1000;
    console.log(`[webui] User signed in: ${email}`);

    // Return fake user in v2 format: { success: true, data: {user} }
    const fakeUser = getFakeUser(realUser);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true, data: fakeUser }));
  } catch (err) {
    console.error('[webui] Signin error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, data: { code: 'ERR_SERVER', details: err.message } }));
  }
}

// Handle SPA signout: clear JWT + creds, return success
function handleSignout(res) {
  clearJwt();
  // Clear saved credentials AND anon flag so getJwt() returns null (guest mode)
  const cfgPath = join(__dirname, '../.config/config.json');
  try {
    const cfg = { ..._config };
    delete cfg.qwenLogin;
    delete cfg.ANON;
    saveConfig(cfg);
    Object.assign(_config, cfg);
  } catch {}
  console.log('[webui] User signed out (creds + anon cleared)');
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ success: true, data: { status: true } }));
}

// Handle demo login: enable ANON mode, reload page
function handleDemoLogin(res) {
  const newCfg = { ..._config, ANON: true };
  delete newCfg.qwenLogin; // clear any real creds
  saveConfig(newCfg);
  Object.assign(_config, newCfg);
  // Set a fake JWT so mock routes activate immediately
  _jwt = 'anon-demo-mode';
  _jwtExpiry = Date.now() + 365 * 24 * 3600 * 1000; // 1 year
  _user = getFakeUser();
  console.log('[webui] Demo mode enabled (ANON)');
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ success: true, data: { status: true } }));
}

// ─── Mock routes (return fake user without upstream call) ──────

function getAuthUserResponse(realUser = null) {
  return JSON.stringify(getFakeUser(realUser));
}

function getV2AuthUserResponse(realUser = null) {
  return JSON.stringify({ success: true, data: getFakeUser(realUser) });
}

// Endpoints that crash the SPA when upstream returns {success:false}.
// Mock them with proper empty data shapes in ANON mode.
const ANON_EMPTY_ARRAY = JSON.stringify({ success: true, data: [] });
const ANON_EMPTY_OBJ = JSON.stringify({ success: true, data: {} });

const MOCK_ROUTES = [
  // v1 auth — returns user object directly (real user with role forced to "user")
  { match: '/api/v1/auths/', body: () => getAuthUserResponse(_user) },
  // v2 auth — returns { success, data: {user} }
  { match: '/api/v2/auths/', body: () => getV2AuthUserResponse(_user), excludeExact: ['/api/v2/auths/signin', '/api/v2/auths/signout'] },
];

// ANON-mode mocks: return empty data so SPA doesn't crash on destructuring.
const ANON_MOCK_ROUTES = [
  { match: '/api/v1/auths/', body: () => getAuthUserResponse() },
  { match: '/api/v2/auths/', body: () => getV2AuthUserResponse(), excludeExact: ['/api/v2/auths/signin', '/api/v2/auths/signout'] },
  { match: '/api/v2/chats', body: () => ANON_EMPTY_ARRAY },          // pinned chats, chat list, new chat
  { match: '/api/v2/folders/', body: () => ANON_EMPTY_ARRAY },
  { match: '/api/v2/projects/', body: () => ANON_EMPTY_ARRAY },
  { match: '/api/v2/users/user/settings', body: () => ANON_EMPTY_OBJ },
  { match: '/api/v2/users/user/entitlement', body: () => ANON_EMPTY_OBJ },
  { match: '/api/v2/users/user/entitlement_quota', body: () => ANON_EMPTY_OBJ },
  { match: '/api/v2/notifications/', body: () => ANON_EMPTY_ARRAY },
  { match: '/api/v1/notifications/', body: () => ANON_EMPTY_ARRAY },
  { match: '/api/v2/mcp/list', body: () => ANON_EMPTY_ARRAY },
];

function findMockRoute(pathname) {
  if (!_jwt && !_config.ANON) return null;

  // In ANON mode: mock auth routes + private endpoints that would crash
  if (_config.ANON) {
    // Check public APIs first — these should be proxied, not mocked
    const isPublicApi = pathname.startsWith('/api/v2/configs')
      || pathname.startsWith('/api/v2/tts/')
      || pathname === '/api/v2/users/status'
      || pathname.startsWith('/api/models');
    if (isPublicApi) return null;

    // Check ANON mocks
    const anonMock = ANON_MOCK_ROUTES.find(r => {
      if (r.excludeExact && r.excludeExact.includes(pathname)) return false;
      return pathname === r.match || pathname.startsWith(r.match);
    });
    if (anonMock) return anonMock;

    // Catch-all: any other unmatched /api/ route returns empty array
    if (pathname.startsWith('/api/')) {
      return { body: () => ANON_EMPTY_ARRAY };
    }
    return null;
  }

  // Normal auth mode: mock auth routes with real user data
  return MOCK_ROUTES.find(r => {
    if (r.excludeExact && r.excludeExact.includes(pathname)) return false;
    return pathname === r.match || pathname.startsWith(r.match);
  });
}

// ─── Inject scripts ──────────────────────────────────────────

// HEAD_INJECT_SCRIPT: runs before main.js. Fetch interceptor + data patching.
const HEAD_INJECT_SCRIPT = `
<script>
(function() {
  // 1. Patch __prerendered_data user role to "user" before SPA reads it.
  // When the HTML is served with auth cookies, the SSR may include a user object
  // with role:"pending" for unverified accounts. Force it to "user".
  try {
    if (window.__prerendered_data && window.__prerendered_data.user) {
      window.__prerendered_data.user.role = 'user';
    }
  } catch (e) {}

  // 2. Intercept fetch to add source:desktop header + SSE toggle
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    init = init || {};
    init.headers = init.headers || {};
    if (typeof input === 'string' && input.startsWith('/api/')) {
      if (init.headers instanceof Headers) {
        init.headers.set('source', 'desktop'); // replace, not append
      } else if (typeof init.headers === 'object') {
        init.headers['source'] = 'desktop'; // replace, not append
      }
    }
    if (typeof input === 'string' && input.includes('/chat/completions')) {
      var sseEnabled = window.__qwenSseEnabled !== false;
      if (!sseEnabled && init.body) {
        try {
          var body = JSON.parse(init.body);
          if (body.stream === true || body.stream === undefined) {
            body.stream = false;
            init.body = JSON.stringify(body);
          }
        } catch (e) {}
      }
    }
    return origFetch.call(this, input, init);
  };

  // 3. Intercept XHR (axios) to add source:desktop header (replace, not append)
  var origXhrOpen = XMLHttpRequest.prototype.open;
  var origXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._url = url;
    return origXhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    if (this._url && typeof this._url === 'string' && this._url.includes('/api/')) {
      this.setRequestHeader('source', 'desktop'); // replace, not append
    }
    return origXhrSend.apply(this, arguments);
  };

  // 4. Safety net: remove account-pending overlay if it still appears
  // (the role rewrite should prevent it, but this catches edge cases)
  function startObserver() {
    if (!document.body) return setTimeout(startObserver, 50);
    var observer = new MutationObserver(function() {
      var overlay = document.querySelector('.account-pending-overlay');
      if (overlay) overlay.remove();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  startObserver();
})();
</script>
`;

// BODY_INJECT_SCRIPT: runs after DOM ready. SSE toggle + Demo login buttons.
const BODY_INJECT_SCRIPT = `
<script>
(function() {
  // SSE Toggle button
  function createToggle() {
    if (document.getElementById('sse-toggle')) return;
    var btn = document.createElement('div');
    btn.id = 'sse-toggle';
    btn.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;background:#615ced;color:#fff;padding:8px 14px;border-radius:20px;font-size:12px;font-family:inherit;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);user-select:none;display:flex;align-items:center;gap:6px;transition:opacity .2s';
    btn.innerHTML = '<span id="sse-status">SSE: ON</span>';
    btn.onclick = function() {
      window.__qwenSseEnabled = window.__qwenSseEnabled !== false ? false : true;
      document.getElementById('sse-status').textContent = 'SSE: ' + (window.__qwenSseEnabled !== false ? 'ON' : 'OFF');
      btn.style.background = window.__qwenSseEnabled !== false ? '#615ced' : '#666';
    };
    document.body.appendChild(btn);
  }

  // Demo Login button (visible only when not logged in and not in ANON mode)
  function createDemoLogin() {
    if (document.getElementById('demo-login-btn')) return;
    var btn = document.createElement('div');
    btn.id = 'demo-login-btn';
    btn.style.cssText = 'position:fixed;bottom:16px;right:120px;z-index:99999;background:#10b981;color:#fff;padding:8px 14px;border-radius:20px;font-size:12px;font-family:inherit;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);user-select:none;display:flex;align-items:center;gap:6px;transition:opacity .2s';
    btn.textContent = 'Login as Demo';
    btn.onclick = function() {
      btn.textContent = 'Loading...';
      fetch('/api/demo-login', { method: 'POST' })
        .then(function() { window.location.reload(); })
        .catch(function() { btn.textContent = 'Error — retry'; });
    };
    document.body.appendChild(btn);
  }

  // Show/hide demo button based on auth state
  function updateDemoButton() {
    var btn = document.getElementById('demo-login-btn');
    if (!btn) return;
    // Hide in ANON mode, or if logged in (token cookie or SPA rendered chat UI)
    if (window.__qwen_anon_mode) {
      btn.style.display = 'none';
      return;
    }
    var hasToken = document.cookie.includes('token=');
    var hasChat = !!document.querySelector('.desktop-layout, .sidebar, .chat-input');
    if (hasToken || hasChat) {
      btn.style.display = 'none';
    } else {
      btn.style.display = 'flex';
    }
  }

  window.__qwenSseEnabled = true;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      createToggle();
      createDemoLogin();
      updateDemoButton();
      setTimeout(updateDemoButton, 2000); // re-check after SPA loads
    });
  } else {
    createToggle();
    createDemoLogin();
    updateDemoButton();
    setTimeout(updateDemoButton, 2000);
  }
})();
</script>
`;

// ─── Patch HTML: replace prerendered user data ──────────────

function patchHtml(html, jwt) {
  let patched = html;

  // Version marker for cache-busting verification
  patched = patched.replace('<head>', '<head><!-- QWEN-SLURP-V3 -->');

  // Inject ANON mode flag so the demo button can hide itself
  if (_config.ANON) {
    patched = patched.replace('<head>', '<head><script>window.__qwen_anon_mode=true;</script>');
  }

  // 1. Strip ALL SSR content from #root so React uses createRoot (not hydrateRoot).
  // The SSR renders the entire app (sidebar, chat, etc.) inside #root.
  // We replace everything from <div id="root"> to the next <script or </body>
  // with an empty root div, avoiding hydration mismatches and raw HTML leaks.
  patched = patched.replace(
    /<div id="root">[\s\S]*?(?=<script|<\/body>)/,
    '<div id="root"></div>\n  '
  );

  // 2. Inject critical script BEFORE main.js
  patched = patched.replace(
    /(<script[^>]*type=module[^>]*src=[^>]*main\.js[^>]*>)/,
    `${HEAD_INJECT_SCRIPT}$1`
  );

  // 3. Inject rest before </body>
  patched = patched.replace('</body>', `${BODY_INJECT_SCRIPT}</body>`);

  return patched;
}

// ─── Proxy a request to upstream ────────────────────────────

async function proxyToUpstream(req, res, pathname, search, body, jwt, cookies) {
  const url = `${UPSTREAM}${pathname}${search}`;
  const isSse = pathname.includes('/chat/completions');

  const headers = {
    'accept': req.headers.accept || '*/*',
    'content-type': req.headers['content-type'] || 'application/json',
    'source': 'desktop',
    'authorization': jwt ? `Bearer ${jwt}` : '',
    'cookie': cookies || '',
    'referer': UPSTREAM + '/',
    'user-agent': DESKTOP_UA,
    'x-request-id': req.headers['x-request-id'] || randomUUID(),
  };
  if (isSse) headers['X-Accel-Buffering'] = 'no';

  try {
    const resp = await fetch(url, {
      method: req.method,
      headers,
      body: body || undefined,
    });

    // Handle SSE streaming — pipe through
    if (isSse && (resp.headers.get('content-type')?.includes('event-stream') || resp.headers.get('content-type')?.includes('octet-stream'))) {
      res.writeHead(resp.status, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      const reader = resp.body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } catch (e) {
          console.error('[webui] SSE stream error:', e.message);
        }
        res.end();
      };
      pump();
      return;
    }

    // Regular response
    const respBody = await resp.text();
    const respHeaders = {
      'Content-Type': resp.headers.get('content-type') || 'application/json',
      'Access-Control-Allow-Origin': '*',
    };
    res.writeHead(resp.status, respHeaders);
    res.end(respBody);
  } catch (err) {
    console.error(`[webui] Proxy error for ${pathname}:`, err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Proxy error: ${err.message}`, type: 'server_error' } }));
  }
}

// ─── Serve the SPA HTML ──────────────────────────────────────

async function serveHtml(req, res, pathname, search, jwt, cookies) {
  try {
    const resp = await fetch(`${UPSTREAM}${pathname}${search}`, {
      headers: {
        'accept': 'text/html,application/xhtml+xml',
        'cookie': cookies || '',
        'user-agent': DESKTOP_UA,
        'referer': UPSTREAM + '/',
      },
    });

    let html = await resp.text();
    html = patchHtml(html, jwt);

    const respHeaders = {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Access-Control-Allow-Origin': '*',
    };
    // Set the token cookie so the SPA thinks it's authenticated
    if (jwt) {
      const cookieExpiry = new Date(Date.now() + 3600 * 1000).toUTCString();
      respHeaders['Set-Cookie'] = `token=${jwt}; Path=/; Expires=${cookieExpiry}; SameSite=Lax`;
    }
    res.writeHead(resp.status, respHeaders);
    res.end(html);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end(`<h1>Proxy Error</h1><p>${err.message}</p>`);
  }
}

// ─── Main handler ────────────────────────────────────────────

export async function handleWebUI(req, res, url) {
  const pathname = url.pathname;
  const search = url.search || '';

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }

  // Read request body
  const body = req.method !== 'GET' && req.method !== 'HEAD'
    ? await new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
      })
    : null;

  // ── Auth actions ─────────────────────────────────────────────
  // Sign in: proxy to upstream, save creds, return fake user
  if (pathname === '/api/v2/auths/signin' && req.method === 'POST') {
    return handleSignin(req, res, body);
  }
  // Sign out: clear JWT + creds, return success
  if (pathname === '/api/v2/auths/signout') {
    return handleSignout(res);
  }
  // Demo login: enable ANON mode (no real creds needed)
  if (pathname === '/api/demo-login') {
    return handleDemoLogin(res);
  }

  // Get JWT (null in guest mode — no creds configured)
  let jwt = null, cookies = null, user = null;
  try {
    ({ jwt, cookies, user } = await getJwt() || {});
  } catch (err) {
    console.error('[webui] Auth error:', err.message);
    // Continue in guest mode — SPA will show login screen
  }

  // ── Mock auth routes (return fake "Qwen Slurp" user) ────────
  const mock = findMockRoute(pathname);
  if (mock) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(mock.body());
  }

  // HTML pages — serve with auth injection + cookie
  if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/c/') || pathname === '/auth' || pathname.startsWith('/authorize'))) {
    return serveHtml(req, res, pathname, search, jwt, cookies);
  }

  // API routes — proxy to upstream with auth (if we have JWT)
  if (pathname.startsWith('/api/')) {
    // In ANON mode: proxy all API calls without JWT.
    // Public endpoints (configs, tts, models) work fine; private ones
    // return {success:false} from upstream which the SPA handles gracefully.
    if (_config.ANON) {
      return proxyToUpstream(req, res, pathname, search, body, null, '');
    }
    // Config/TTS/users-status/models endpoints are public (work without auth).
    const isPublicApi = pathname.startsWith('/api/v2/configs')
      || pathname.startsWith('/api/v2/tts/')
      || pathname === '/api/v2/users/status'
      || pathname.startsWith('/api/models');
    if (!jwt && !isPublicApi) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ success: false, data: { code: 'Forbidden', details: 'Not authenticated' } }));
    }
    return proxyToUpstream(req, res, pathname, search, body, jwt, cookies);
  }

  // Static files — proxy
  if (req.method === 'GET') {
    return proxyToUpstream(req, res, pathname, search, null, jwt, cookies);
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}
