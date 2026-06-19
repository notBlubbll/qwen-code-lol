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
function applyConfig(cfg) {
  const keys = Object.keys(_config);
  for (const k of keys) {
    if (!(k in cfg)) delete _config[k];
    else _config[k] = cfg[k];
  }
  for (const k of Object.keys(cfg)) {
    if (!(k in _config)) _config[k] = cfg[k];
  }
}
function saveConfig(cfg) {
  const cfgPath = join(__dirname, '../.config/config.json');
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}
// Read fresh from disk, apply a mutation, save, and sync _config.
// This avoids overwriting external config edits with stale in-memory state.
function mutateConfig(mutator) {
  const disk = loadConfig();
  mutator(disk);
  saveConfig(disk);
  applyConfig(disk);
  return disk;
}
const _config = loadConfig();

// ─── Fake JWT (valid base64url structure, SPA can decode without crashing) ──

function generateFakeJwt() {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'anon-user-id',
    email: 'anon@qwen.ai',
    name: 'Anon',
    role: 'user',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
  })).toString('base64url');
  const sig = Buffer.from('qwen-slurp-anon-signature-' + Date.now()).toString('base64url').slice(0, 43);
  return header + '.' + payload + '.' + sig;
}

let _anonJwt = generateFakeJwt();

// ─── Fake user (for ANON mode and logged-in mode) ──────────────

function getAnonUser() {
  return {
    id: 'a0000000-0000-0000-0000-000000000001',
    email: 'anon@qwen.ai',
    name: 'Anon',
    role: 'user',
    profile_image_url: '',
    tier: '',
    token: _anonJwt,
    token_type: 'Bearer',
    expires_at: Math.floor((Date.now() + 365 * 24 * 3600 * 1000) / 1000),
    permissions: {
      workspace: { models: false, knowledge: false, prompts: false, tools: false },
      chat: { file_upload: true, delete: true, edit: true, temporary: true },
    },
  };
}

function getFakeUser(realUser) {
  return {
    id: realUser?.id || randomUUID(),
    email: realUser?.email || 'unknown@qwen.ai',
    name: realUser?.name || 'Qwen User',
    role: 'user',
    profile_image_url: realUser?.profile_image_url || '',
    tier: realUser?.tier || '',
    token: realUser?.token || _jwt || '',
    token_type: 'Bearer',
    expires_at: realUser?.expires_at || Math.floor((Date.now() + 3600 * 1000) / 1000),
    permissions: realUser?.permissions || {
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
let _loggedOut = false;

function isLoggedIn() {
  return !_loggedOut && _jwt && Date.now() < _jwtExpiry;
}

async function getJwt(forceLogin = false) {
  if (isLoggedIn()) {
    return { jwt: _jwt, cookies: _cookies, user: _user };
  }

  if (_loggedOut && !forceLogin) return null;

  const { email, password, passwordHash } = _config.qwenLogin || {};
  if (!email || (!password && !passwordHash)) return null;

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

// ─── SPA signin handler ──────────────────────────────────────

async function handleSignin(req, res, body) {
  try {
    const { email, password } = JSON.parse(body);
    if (email && password) {
      mutateConfig(cfg => {
        cfg.qwenLogin = { email, passwordHash: password };
        delete cfg.ANON;
      });
      console.log(`[webui] Saved credentials for ${email}`);
    }

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
    _loggedOut = false;
    console.log(`[webui] User signed in: ${email}`);

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
  _loggedOut = true;
  try {
    mutateConfig(cfg => {
      delete cfg.qwenLogin;
      delete cfg.ANON;
    });
  } catch {}
  console.log('[webui] User signed out');
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ success: true, data: { status: true } }));
}

// Handle anon mode toggle
function handleAnonToggle(res, enable, redirect) {
  if (enable) {
    clearJwt();
    _loggedOut = false;
    _anonJwt = generateFakeJwt();
  } else {
    clearJwt();
    _loggedOut = true;
  }
  mutateConfig(cfg => {
    if (enable) cfg.ANON = true;
    else delete cfg.ANON;
  });
  console.log(`[webui] ANON mode ${enable ? 'enabled' : 'disabled'}`);

  if (redirect && !enable) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': 'token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax',
    });
    return res.end(`<!DOCTYPE html><html><head><script>
      localStorage.clear();
      sessionStorage.clear();
      document.cookie.split(';').forEach(function(c){document.cookie=c.replace(/^ +/,'').replace(/=.*/,'=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/');});
      window.location.replace('/auth');
    </script></head><body></body></html>`);
  }

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ success: true, data: { status: true } }));
}

// ─── Mock routes ──────────────────────────────────────────────

function getV1AuthUserResponse(user) {
  return JSON.stringify(user || getAnonUser());
}

function getV2AuthUserResponse(user) {
  return JSON.stringify({ success: true, request_id: randomUUID(), data: user || getAnonUser() });
}

const ANON_SETTINGS = JSON.stringify({
  success: true,
  request_id: '',
  data: {
    ui: {
      notificationEnabled: false, theme: 'dark', language: '', chatBubble: true,
      showUsername: false, widescreenMode: false, title: {}, autoTags: true,
      largeTextAsFile: true, splitLargeChunks: false, scrollOnBranchChange: true,
      responseAutoCopy: false, models: [],
    },
    mcp_remind: true, mcp_remind_time: '',
  },
});

function findMockRoute(pathname) {
  // ── ANON mode: mock auth + all private endpoints ──
  if (_config.ANON) {
    // Public APIs: proxy to upstream (no JWT needed)
    if (pathname.startsWith('/api/v2/configs') ||
        pathname.startsWith('/api/v2/tts/') ||
        pathname === '/api/v2/users/status' ||
        pathname.startsWith('/api/v2/models') ||
        pathname.startsWith('/api/models')) {
      return null;
    }

    // Auth routes: return fake Anon user
    if ((pathname.startsWith('/api/v1/auths/') || pathname.startsWith('/api/v2/auths/')) &&
        pathname !== '/api/v2/auths/signin' && pathname !== '/api/v2/auths/signout') {
      if (pathname.startsWith('/api/v2/')) return { body: () => getV2AuthUserResponse() };
      return { body: () => getV1AuthUserResponse() };
    }

    // Chat completions + new chat: must proxy to upstream with REAL JWT
    // (so ANON users can actually chat). getJwt() will use qwenLogin creds.
    if (pathname.includes('/chat/completions') ||
        pathname === '/api/v2/chats/new') {
      return null;
    }
    // Specific chat ID (PUT/DELETE) — proxy with real JWT
    if (/^\/api\/v2\/chats\/[0-9a-f-]{36}$/.test(pathname)) {
      return null;
    }

    // Chat list, pinned, search — mock empty
    if (pathname.startsWith('/api/v2/chats')) {
      return { body: () => '{"success":true,"request_id":"","data":[]}' };
    }

    // User endpoints
    if (pathname === '/api/v2/users/user/settings') {
      return { body: () => ANON_SETTINGS };
    }
    if (pathname.startsWith('/api/v2/users/user/entitlement')) {
      return { body: () => '{"success":false,"request_id":"","data":{"code":"not found","details":"Not Found"}}' };
    }

    // Folders, projects, library, mcp, notifications
    if (pathname.startsWith('/api/v2/folders/') ||
        pathname.startsWith('/api/v2/projects/') ||
        pathname.startsWith('/api/v2/library/') ||
        pathname.startsWith('/api/v2/mcp/') ||
        pathname.startsWith('/api/v1/notifications/') ||
        pathname.startsWith('/api/v2/notifications/')) {
      return { body: () => '{"success":true,"request_id":"","data":[]}' };
    }

    // Catch-all for any other /api/ route we missed
    if (pathname.startsWith('/api/')) {
      return { body: () => '{"success":true,"request_id":"","data":[]}' };
    }

    return null;
  }

  // ── Logged-in mode: mock auth routes with real user data ──
  if (!isLoggedIn()) return null;
  if ((pathname.startsWith('/api/v1/auths/') || pathname.startsWith('/api/v2/auths/')) &&
      pathname !== '/api/v2/auths/signin' && pathname !== '/api/v2/auths/signout') {
    if (pathname.startsWith('/api/v2/')) return { body: () => getV2AuthUserResponse(getFakeUser(_user)) };
    return { body: () => getV1AuthUserResponse(getFakeUser(_user)) };
  }
  return null;
}

// ─── Inject scripts ──────────────────────────────────────────

const HEAD_INJECT_SCRIPT = `
<script>
(function() {
  try {
    if (window.__prerendered_data && window.__prerendered_data.user) {
      window.__prerendered_data.user.role = 'user';
    }
  } catch (e) {}

  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    init = init || {};
    var url = typeof input === 'string' ? input : (input instanceof Request ? input.url : '');
    if (url.startsWith('/api/')) {
      init.headers = init.headers || {};
      if (init.headers instanceof Headers) {
        init.headers.set('source', 'desktop');
      } else if (typeof init.headers === 'object') {
        init.headers['source'] = 'desktop';
      }
    }
    // Rewrite CDN image fetches to go through /img proxy (avoids orb blocking)
    if (url.indexOf('cdn.qwenlm.ai') !== -1 || url.indexOf('img.alicdn.com') !== -1 || url.indexOf('assets.alicdn.com') !== -1 || (url.indexOf('/output/') !== -1 && url.indexOf('/img?') === -1)) {
      var proxyUrl = url;
      if (proxyUrl.indexOf('//') === 0) proxyUrl = 'https:' + proxyUrl; // protocol-relative
      var newUrl = '/img?url=' + encodeURIComponent(proxyUrl);
      input = newUrl;
      url = newUrl;
    }
    if (url.includes('/chat/completions')) {
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

  var origXhrOpen = XMLHttpRequest.prototype.open;
  var origXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  var origXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._url = url;
    this._sourceSet = false;
    return origXhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (name.toLowerCase() === 'source' && this._url && typeof this._url === 'string' && this._url.includes('/api/')) {
      this._sourceSet = true;
      return origXhrSetHeader.call(this, 'source', 'desktop');
    }
    return origXhrSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    if (!this._sourceSet && this._url && typeof this._url === 'string' && this._url.includes('/api/')) {
      origXhrSetHeader.call(this, 'source', 'desktop');
    }
    return origXhrSend.apply(this, arguments);
  };

  // Rewrite CDN image URLs to go through our /img proxy (avoids orb blocking)
  function proxyImg(src) {
    if (!src || typeof src !== 'string') return src;
    if (src.indexOf('/img?url=') !== -1) return src; // already proxied
    if (src.indexOf('cdn.qwenlm.ai') === -1 &&
        src.indexOf('/output/') === -1 &&
        src.indexOf('img.alicdn.com') === -1 &&
        src.indexOf('assets.alicdn.com') === -1) return src;
    // Protocol-relative URL (//assets.alicdn.com/...) → prepend https:
    if (src.indexOf('//') === 0) src = 'https:' + src;
    return '/img?url=' + encodeURIComponent(src);
  }
  // Rewrite a CSS url(...) value, proxying any CDN image URLs inside it
  function proxyCssUrl(value) {
    if (!value || typeof value !== 'string') return value;
    if (value.indexOf('/img?url=') !== -1) return value; // already proxied
    if (value.indexOf('cdn.qwenlm.ai') === -1 &&
        value.indexOf('/output/') === -1 &&
        value.indexOf('img.alicdn.com') === -1 &&
        value.indexOf('assets.alicdn.com') === -1) return value;
    // Match url(...) including quotes: url("..."), url('...'), or url(...)
    return value.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, function(match, url) {
      if (!isCdnUrl(url)) return match;
      return 'url("' + proxyImg(url) + '")';
    });
  }
  function isCdnUrl(s) {
    if (!s || typeof s !== 'string') return false;
    if (s.indexOf('/img?url=') !== -1) return false; // already proxied
    return s.indexOf('cdn.qwenlm.ai') !== -1 ||
           s.indexOf('/output/') !== -1 ||
           s.indexOf('img.alicdn.com') !== -1 ||
           s.indexOf('assets.alicdn.com') !== -1;
  }
  // Intercept setAttribute — React sets style as a whole string via setAttribute('style', ...)
  var origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if (typeof value === 'string' && name === 'src' && isCdnUrl(value)) {
      value = proxyImg(value);
    }
    return origSetAttribute.call(this, name, value);
  };
  // Intercept style.setProperty so React's style updates get proxied
  var origSetProperty = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function(name, value, pri) {
    if (typeof value === 'string' && (name === 'background-image' || name === 'background' || name === 'border-image' || name === 'list-style-image')) {
      value = proxyCssUrl(value);
    }
    return origSetProperty.call(this, name, value, pri);
  };
  // Note: el.style.backgroundImage = "url(...)" cannot be intercepted in Chromium
  // (it's an own property, not on prototype). We use a requestAnimationFrame poll
  // in the MutationObserver to catch and rewrite these after React sets them.
  function rewriteBg(el) {
    if (!el || !el.style) return;
    if (el.__qwenBgDone) return;
    var bg = el.style.backgroundImage;
    if (!bg || bg === 'none') return;
    if (!isCdnUrl(bg)) return;
    // Rewrite via setAttribute('style', ...) which replaces the entire style string
    var cssText = el.getAttribute('style') || '';
    if (isCdnUrl(cssText)) {
      origSetAttribute.call(el, 'style', proxyCssUrl(cssText));
      el.__qwenBgDone = true;
    }
  }
  function rewriteImg(el) {
    if (!el || el.tagName !== 'IMG') return;
    if (el.__qwenImgDone) return;
    var s = el.getAttribute('src');
    if (s && isCdnUrl(s)) {
      origSetAttribute.call(el, 'src', proxyImg(s));
      el.__qwenImgDone = true;
    }
  }
  function rewriteEl(el) {
    if (!el || el.nodeType !== 1) return;
    if (el.tagName === 'IMG') rewriteImg(el);
    else rewriteBg(el);
    if (el.querySelectorAll) {
      var imgs = el.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) rewriteImg(imgs[i]);
      var divs = el.querySelectorAll('[style*="background-image"], [style*="cdn.qwenlm.ai"], [style*="alicdn.com"], [style*="output"]');
      for (var j = 0; j < divs.length; j++) rewriteBg(divs[j]);
    }
  }

  function startObserver() {
    if (!document.body) return setTimeout(startObserver, 50);
    var observer = new MutationObserver(function(mutations) {
      var overlay = document.querySelector('.account-pending-overlay');
      if (overlay) overlay.remove();
      var cookie = document.querySelector('[class*="cookie-confirm"]');
      if (cookie) cookie.remove();
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === 'childList' && m.addedNodes) {
          for (var j = 0; j < m.addedNodes.length; j++) {
            var n = m.addedNodes[j];
            if (n.nodeType === 1) {
              rewriteEl(n);
            }
          }
        } else if (m.type === 'attributes') {
          rewriteEl(m.target);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'src'] });
  }
  startObserver();
})();
</script>
`;

const BODY_INJECT_SCRIPT = `
<script>
(function() {
  window.__qwenSseEnabled = true;

  function createToggle() {
    if (document.getElementById('sse-toggle')) return;
    var btn = document.createElement('div');
    btn.id = 'sse-toggle';
    btn.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;background:#615ced;color:#fff;padding:8px 14px;border-radius:20px;font-size:12px;font-family:inherit;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);user-select:none;display:flex;align-items:center;gap:6px';
    btn.innerHTML = '<span id="sse-status">SSE: ON</span>';
    btn.onclick = function() {
      window.__qwenSseEnabled = window.__qwenSseEnabled !== false ? false : true;
      document.getElementById('sse-status').textContent = 'SSE: ' + (window.__qwenSseEnabled !== false ? 'ON' : 'OFF');
      btn.style.background = window.__qwenSseEnabled !== false ? '#615ced' : '#666';
    };
    document.body.appendChild(btn);
  }

  function createAnonBtn() {
    if (document.getElementById('anon-toggle-btn')) return;
    var btn = document.createElement('div');
    btn.id = 'anon-toggle-btn';
    btn.style.cssText = 'position:fixed;bottom:16px;right:120px;z-index:99999;background:#10b981;color:#fff;padding:8px 14px;border-radius:20px;font-size:12px;font-family:inherit;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);user-select:none;display:flex;align-items:center;gap:6px';
    if (window.__qwen_anon_mode) {
      btn.textContent = 'Exit Anon';
      btn.style.background = '#ef4444';
      btn.onclick = function() {
        window.location.href = '/api/anon-toggle?enable=false&redirect=1';
      };
    } else {
      btn.textContent = 'Anon Mode';
      btn.onclick = function() {
        btn.textContent = 'Loading...';
        fetch('/api/anon-toggle?enable=true', { method: 'POST' })
          .then(function() { window.location.reload(); });
      };
    }
    document.body.appendChild(btn);
  }

  function createAnonLabel() {
    if (!window.__qwen_anon_mode) return;
    if (document.getElementById('anon-label')) return;
    var label = document.createElement('div');
    label.id = 'anon-label';
    label.textContent = 'ANON';
    label.style.cssText = 'position:fixed;top:12px;left:12px;z-index:99999;background:#f59e0b;color:#000;padding:4px 10px;border-radius:12px;font-size:11px;font-weight:bold;font-family:inherit;pointer-events:none';
    document.body.appendChild(label);
  }

  function init() {
    createToggle();
    createAnonBtn();
    createAnonLabel();
    setTimeout(createAnonLabel, 2000);
    setTimeout(createAnonLabel, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>
`;

// ─── Patch HTML ───────────────────────────────────────────────

function patchHtml(html, jwt) {
  let patched = html;

  patched = patched.replace('<head>', '<head><!-- QWEN-SLURP-V5 -->');

  if (_config.ANON) {
    patched = patched.replace('<head>', '<head><script>Object.defineProperty(window,"__qwen_anon_mode",{value:true,writable:false,configurable:false});</script>');
  }

  patched = patched.replace(
    /<div id="root">[\s\S]*?(?=<script|<\/body>)/,
    '<div id="root"></div>\n  '
  );

  patched = patched.replace(
    /(<script(?![^>]*\bsrc=)(?![^>]*\btype=module)(?![^>]*\bid=["']__prerendered_data)[^>]*>)([\s\S]*?)(<\/script>)/g,
    function(match, openTag, code, closeTag) {
      if (code.trim().length === 0) return match;
      return openTag + 'try{' + code + '}catch(e){}' + closeTag;
    }
  );

  patched = patched.replace(
    /(<script[^>]*type=module[^>]*src=[^>]*main\.js[^>]*>)/,
    `${HEAD_INJECT_SCRIPT}$1`
  );

  const afterBodyMatch = patched.match(/<\/body>([\s\S]*?)<\/html>/);
  const afterBodyScripts = afterBodyMatch ? afterBodyMatch[1].trim() : '';
  if (afterBodyScripts) {
    patched = patched.replace(/<\/body>[\s\S]*<\/html>/, '');
    patched += `${BODY_INJECT_SCRIPT}\n${afterBodyScripts}\n</body>\n</html>`;
  } else {
    patched = patched.replace('</body>', `${BODY_INJECT_SCRIPT}</body>`);
  }

  return patched;
}

// Extract the user prompt text from a Qwen-native chat completion request body.
function extractWebPrompt(bodyStr) {
  if (!bodyStr) return '';
  try {
    const body = JSON.parse(bodyStr);
    const msgs = body.messages;
    if (!Array.isArray(msgs)) return '';
    let msg = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === 'user') { msg = msgs[i]; break; }
    }
    if (!msg) msg = msgs[msgs.length - 1];
    const c = msg?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.filter(p => typeof p === 'string' || p?.type === 'text')
        .map(p => typeof p === 'string' ? p : p.text || '')
        .join('\n');
    }
  } catch {}
  return '';
}

// ─── Proxy a request to upstream ────────────────────────────

async function proxyToUpstream(req, res, pathname, search, body, jwt, cookies) {
  const url = `${UPSTREAM}${pathname}${search}`;
  const isSse = pathname.includes('/chat/completions');

  // Un-rewrite proxied media URLs in request bodies (SPA sends http://127.0.0.1:PORT/img/<filename>?key=proxy&url=...
  // back to upstream APIs like share_url — restore the original CDN URL)
  if (body && body.includes('/img/')) {
    body = body.replace(/https?:\/\/[^"'\s]+\/img\/[^"'\s?]+\?key=proxy&url=([^"&\s]+)/g, (match, encoded) => {
      try { return decodeURIComponent(encoded); } catch { return match; }
    }).replace(/https?:\/\/[^"'\s]+\/img\?key=proxy&url=([^"&\s]+)/g, (match, encoded) => {
      try { return decodeURIComponent(encoded); } catch { return match; }
    }).replace(/https?:\/\/[^"'\s]+\/img\?url=([^"&\s]+)/g, (match, encoded) => {
      try { return decodeURIComponent(encoded); } catch { return match; }
    });
  }

  if (isSse && body) {
    const prompt = extractWebPrompt(body);
    if (prompt) console.log(`[webui] prompt: ${prompt}`);
  }

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

    if (isSse && (resp.headers.get('content-type')?.includes('event-stream') || resp.headers.get('content-type')?.includes('octet-stream'))) {
      res.writeHead(resp.status, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      const reader = resp.body.getReader();
      const pump = async () => {
        let sseBuf = '';
        let loggedTools = new Set();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
            // Scan SSE for tool calls (function_call) — log each tool name once
            sseBuf += new TextDecoder().decode(value, { stream: true });
            const lines = sseBuf.split('\n');
            sseBuf = lines.pop() || '';
            for (const line of lines) {
              const t = line.trimStart();
              if (!t.startsWith('data:')) continue;
              const d = t.slice(5).trim();
              if (!d || d === '[DONE]') continue;
              try {
                const p = JSON.parse(d);
                const fc = p?.choices?.[0]?.delta?.function_call;
                const name = fc?.name;
                if (name && !loggedTools.has(name)) {
                  loggedTools.add(name);
                  console.log(`[webui] tool_call: ${name}`);
                }
              } catch {}
            }
          }
        } catch (e) {
          console.error('[webui] SSE stream error:', e.message);
        }
        res.end();
      };
      pump();
      return;
    }

    let respBody = await resp.text();
    // Rewrite CDN image URLs in API responses and JS bundles so the SPA never sees them.
    // This prevents ERR_BLOCKED_BY_ORB on background-image / img src.
    if (respBody && (respBody.includes('cdn.qwenlm.ai') || respBody.includes('//assets.alicdn.com') || respBody.includes('//img.alicdn.com'))) {
      const port = _config.port || 3008;
      // Rewrite cdn.qwenlm.ai output URLs (include commas for x-oss-process params)
      // Use ?key= before url= so the SPA's El() check (e.includes("?key=")) passes
      // — this skips the broken share_url API call and downloads directly.
      // Put the original filename in the path so the SPA's Al() extracts it correctly.
      respBody = respBody.replace(/https?:\/\/cdn\.qwenlm\.ai\/output\/[^"'\s)}\]]+/g, (url) => {
        const encoded = encodeURIComponent(url);
        // Extract original filename from the CDN URL path
        const pathPart = url.split('?')[0];
        const filename = pathPart.substring(pathPart.lastIndexOf('/') + 1) || 'download';
        return `http://127.0.0.1:${port}/img/${filename}?key=proxy&url=${encoded}`;
      });
      // Rewrite protocol-relative alicdn URLs (//assets.alicdn.com/..., //img.alicdn.com/...)
      respBody = respBody.replace(/\/\/(assets\.alicdn\.com|img\.alicdn\.com)\/[^"'\s)}\]]+/g, (url) => {
        const encoded = encodeURIComponent('https:' + url);
        const pathPart = url.split('?')[0];
        const filename = pathPart.substring(pathPart.lastIndexOf('/') + 1) || 'download';
        return `http://127.0.0.1:${port}/img/${filename}?key=proxy&url=${encoded}`;
      });
    }
    res.writeHead(resp.status, {
      'Content-Type': resp.headers.get('content-type') || 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(respBody);
  } catch (err) {
    console.error(`[webui] Proxy error for ${pathname}:`, err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Proxy error: ${err.message}`, type: 'server_error' } }));
  }
}

// ─── Serve the SPA HTML ──────────────────────────────────────

// SPA routes (non-API, non-static) that should serve the patched HTML.
// Any single-segment path without a file extension is a SPA route.
function isSpaRoute(pathname) {
  if (pathname.startsWith('/api/')) return false;
  if (pathname.includes('.')) return false; // static files (.js, .css, .png, etc.)
  // Multi-segment routes like /c/:id are already handled above;
  // catch all other single+ paths like /library, /discover, etc.
  return true;
}

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

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }

  const body = req.method !== 'GET' && req.method !== 'HEAD'
    ? await new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
      })
    : null;

  if (pathname === '/api/v2/auths/signin' && req.method === 'POST') {
    return handleSignin(req, res, body);
  }
  if (pathname === '/api/v2/auths/signout') {
    return handleSignout(res);
  }
  if (pathname === '/api/anon-toggle') {
    const enable = url.searchParams.get('enable') !== 'false';
    const redirect = url.searchParams.get('redirect') === '1';
    return handleAnonToggle(res, enable, redirect);
  }

  // Resolve JWT for upstream proxying
  let jwt = null, cookies = null, user = null;
  if (_config.ANON) {
    jwt = _anonJwt;
    try {
      const realAuth = await getJwt();
      if (realAuth) {}
    } catch {}
  } else {
    try {
      ({ jwt, cookies, user } = await getJwt() || {});
    } catch (err) {
      console.error('[webui] Auth error:', err.message);
    }
  }

  // Mock routes
  const mock = findMockRoute(pathname);
  if (mock) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(mock.body());
  }

  // HTML pages
  if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/c/') || pathname === '/auth' || pathname.startsWith('/authorize') || isSpaRoute(pathname))) {
    return serveHtml(req, res, pathname, search, jwt, cookies);
  }

  // API routes
  if (pathname.startsWith('/api/')) {
    if (_config.ANON) {
      // For ANON mode: chat completions and chat CRUD need REAL JWT
      const needsRealJwt = pathname.includes('/chat/completions') ||
        pathname === '/api/v2/chats/new' ||
        pathname.match(/^\/api\/v2\/chats\/[^/]+$/);

      if (needsRealJwt) {
        try {
          const realAuth = await getJwt(true);
          if (realAuth) {
            return proxyToUpstream(req, res, pathname, search, body, realAuth.jwt, realAuth.cookies);
          }
        } catch {}
        // No real creds — fall through to 401
        res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ success: false, data: { code: 'Forbidden', details: 'ANON mode requires qwenLogin credentials for chat' } }));
      }

      // Other API calls: proxy without auth (guest)
      return proxyToUpstream(req, res, pathname, search, body, null, '');
    }

    const isPublicApi = pathname.startsWith('/api/v2/configs')
      || pathname.startsWith('/api/v2/tts/')
      || pathname === '/api/v2/users/status'
      || pathname.startsWith('/api/v2/models')
      || pathname.startsWith('/api/models');
    if (!jwt && !isPublicApi) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ success: false, data: { code: 'Forbidden', details: 'Not authenticated' } }));
    }
    return proxyToUpstream(req, res, pathname, search, body, jwt, cookies);
  }

  if (req.method === 'GET') {
    return proxyToUpstream(req, res, pathname, search, null, jwt, cookies);
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}
