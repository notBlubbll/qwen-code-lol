/**
 * Chat completions handler — OpenAI → Qwen Web API (chat.qwen.ai).
 *
 * Uses the Qwen desktop app's API path (`source: desktop`) which bypasses
 * the Alibaba Baxia WAF. Authentication is via the web login JWT
 * (POST /api/v2/auths/signin with SHA-256 hashed password).
 *
 * Flow:
 *   1. Login → get JWT + cookies
 *   2. Create chat session via POST /api/v2/chats/new
 *   3. Send message via POST /api/v2/chat/completions?chat_id=...
 *   4. Parse SSE stream → OpenAI format
 */

import { randomUUID, createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveModel, MODELS } from './models.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const QWEN_BASE_URL = 'https://chat.qwen.ai';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 AliDesktop(QWENCHAT/1.0.3)';

// ─── Config ───────────────────────────────────────────────────

function loadConfig() {
  const cfgPath = join(__dirname, '../.config/config.json');
  if (existsSync(cfgPath)) {
    try { return JSON.parse(readFileSync(cfgPath, 'utf8')); } catch {}
  }
  return {};
}

let _config = loadConfig();

// ─── Login ────────────────────────────────────────────────────

let _jwt = null;
let _cookies = null;
let _jwtExpiry = 0;

async function login() {
  if (_jwt && Date.now() < _jwtExpiry) return { jwt: _jwt, cookies: _cookies };

  // Reload config (creds may have been updated via Web UI login)
  _config = loadConfig();
  const { email, password, passwordHash } = _config.qwenLogin || {};
  if (!email || (!password && !passwordHash)) {
    throw new Error('No qwenLogin credentials. Configure .config/config.json with qwenLogin.email and qwenLogin.password, or login via the Web UI.');
  }

  // If we have plaintext password, hash it; otherwise use the stored hash directly
  const hash = passwordHash || createHash('sha256').update(password, 'utf8').digest('hex');
  const resp = await fetch(`${QWEN_BASE_URL}/api/v1/auths/signin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'source': 'desktop',
      'User-Agent': DESKTOP_UA,
      'Accept': 'application/json',
      'Origin': QWEN_BASE_URL,
      'Referer': QWEN_BASE_URL + '/',
    },
    body: JSON.stringify({ email, password: hash }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Login failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  if (!data.token) {
    throw new Error(`Login failed: ${JSON.stringify(data).slice(0, 200)}`);
  }

  _jwt = data.token;
  _cookies = (resp.headers.getSetCookie() || []).map(c => c.split(';')[0]).join('; ');
  _jwtExpiry = Date.now() + 3600 * 1000;
  console.log(`[chat] Logged in as ${data.email}`);
  return { jwt: _jwt, cookies: _cookies };
}

// ─── Headers ──────────────────────────────────────────────────

function buildHeaders(jwt, cookies) {
  return {
    'accept': 'text/event-stream',
    'content-type': 'application/json',
    'source': 'desktop',
    'authorization': `Bearer ${jwt}`,
    'cookie': cookies,
    'referer': 'https://chat.qwen.ai/',
    'user-agent': DESKTOP_UA,
    'X-Accel-Buffering': 'no',
  };
}

// Rewrite a CDN image URL to go through our /img proxy (avoids orb blocking).
function proxyImageUrl(url, config) {
  if (!url || typeof url !== 'string') return url;
  const port = config?.port || 3008;
  const pathPart = url.split('?')[0];
  const filename = pathPart.substring(pathPart.lastIndexOf('/') + 1) || 'download';
  return `http://127.0.0.1:${port}/img/${filename}?key=proxy&url=${encodeURIComponent(url)}`;
}

// ─── Message parsing ──────────────────────────────────────────

function parseIncomingMessages(messages) {
  const normalized = (Array.isArray(messages) ? messages : []).map(message => {
    let text = '';
    const content = message?.content;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter(p => p?.type === 'text' || typeof p === 'string')
        .map(p => typeof p === 'string' ? p : p.text || '')
        .join('\n');
    }
    return { role: message?.role || 'user', text };
  });

  if (normalized.length === 0) return { content: '' };

  const last = normalized[normalized.length - 1];
  const history = normalized.slice(0, -1)
    .filter(m => m.text)
    .map(m => {
      const role = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User';
      return `[${role}]: ${m.text}`;
    })
    .join('\n\n');

  const content = history ? `${history}\n\n[User]: ${last.text}` : last.text;
  return { content };
}

// ─── SSE parsing ──────────────────────────────────────────────

// NOTE on upstream cumulative fields:
//   delta.content (phase=answer)            → TRUE DELTA (incremental pieces)
//   delta.extra.summary_thought.content     → CUMULATIVE (full array of thoughts so far)
//   delta.function_call.arguments           → CUMULATIVE (full args string built so far)
//   delta.status: "finished"                → upstream's completion signal (finish_reason is never set)
// We must diff cumulative fields before emitting them as OpenAI deltas.

function extractReasoningContentFromDelta(delta) {
  if (!delta || typeof delta !== 'object') return '';
  const direct = delta.reasoning_content || delta.reasoning || '';
  if (direct) return direct;
  const phase = typeof delta.phase === 'string' ? delta.phase : '';
  if (phase !== 'thinking_summary') return '';
  const thoughtContent = delta?.extra?.summary_thought?.content;
  if (Array.isArray(thoughtContent)) return thoughtContent.filter(Boolean).join('\n');
  return '';
}

// Extract image URLs from tool-result deltas (role: "function").
// These carry generated image links in extra.tool_result / extra.image_list.
function extractImageUrlsFromDelta(delta) {
  if (!delta || typeof delta !== 'object') return [];
  const urls = [];
  const extra = delta.extra;
  if (extra && typeof extra === 'object') {
    if (Array.isArray(extra.tool_result)) {
      for (const r of extra.tool_result) {
        if (r?.image) urls.push(r.image);
      }
    }
    if (Array.isArray(extra.image_list)) {
      for (const r of extra.image_list) {
        if (r?.image) urls.push(r.image);
      }
    }
  }
  return urls;
}

function mapUsageToOpenAI(usage) {
  return {
    prompt_tokens: Number(usage?.input_tokens || 0),
    completion_tokens: Number(usage?.output_tokens || 0),
    total_tokens: Number(usage?.total_tokens || 0),
  };
}

// Stateful mapper that diffs cumulative fields (reasoning, tool-call args)
// so we only emit the new portion as OpenAI deltas.
class DeltaMapper {
  constructor() {
    this._lastReasoning = '';
    this._toolArgs = new Map(); // id → last args string
    this._toolNames = new Map(); // id → name
    this._hadToolCalls = false;
    this._loggedTools = null; // Set<string> — logs each tool name once
  }

  // Returns { delta, finishReason } or null.
  // delta is an OpenAI-format delta object (may be {}).
  // finishReason is 'stop' | 'tool_calls' | null.
  map(parsed) {
    const choice = parsed?.choices?.[0];
    const delta = choice?.delta;
    if (!delta || typeof delta !== 'object') return null;

    const mapped = {};
    let finishReason = choice?.finish_reason || null;

    if (delta.role === 'assistant') mapped.role = delta.role;

    // Content (true delta — pass through)
    if (typeof delta.content === 'string' && delta.content) mapped.content = delta.content;

    // Reasoning (cumulative — diff against last sent)
    const reasoningFull = extractReasoningContentFromDelta(delta);
    if (reasoningFull && reasoningFull.length > this._lastReasoning.length) {
      const diff = reasoningFull.slice(this._lastReasoning.length);
      this._lastReasoning = reasoningFull;
      if (diff) mapped.reasoning_content = diff;
    }

    // Tool calls (function_call.arguments is cumulative — diff per tool id)
    if (delta.function_call) {
      const fnName = delta.function_call.name || '';
      const fnArgs = typeof delta.function_call.arguments === 'string'
        ? delta.function_call.arguments
        : JSON.stringify(delta.function_call.arguments || {});
      const toolId = delta.function_id || `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

      if (fnName) {
        this._toolNames.set(toolId, fnName);
        if (!this._loggedTools) this._loggedTools = new Set();
        if (!this._loggedTools.has(fnName)) {
          this._loggedTools.add(fnName);
          console.log(`[chat] tool_call: ${fnName}`);
        }
      }

      const lastArgs = this._toolArgs.get(toolId) || '';
      const argDiff = fnArgs.length > lastArgs.length ? fnArgs.slice(lastArgs.length) : '';
      this._toolArgs.set(toolId, fnArgs);
      this._hadToolCalls = true;

      if (fnName || argDiff) {
        mapped.tool_calls = [{
          index: 0,
          id: toolId,
          type: 'function',
          function: {
            ...(fnName ? { name: fnName } : {}),
            ...(argDiff ? { arguments: argDiff } : (fnName ? { arguments: '' } : {})),
          },
        }];
      }
    }

    // Upstream never sets finish_reason. Infer from status: "finished".
    if (!finishReason && delta.status === 'finished') {
      // If we emitted tool calls, the completion reason is "tool_calls"
      // only when the tool-result (role: function) arrives. For the
      // answer phase, it's "stop".
      if (delta.phase === 'answer') {
        finishReason = 'stop';
      } else if (delta.role === 'function') {
        finishReason = 'tool_calls';
      }
    }

    return { delta: mapped, finishReason };
  }

  get hadToolCalls() { return this._hadToolCalls; }
  // Final args per tool id (last cumulative value seen)
  getToolCallArgs(toolId) { return this._toolArgs.get(toolId) || ''; }
  getToolCallName(toolId) { return this._toolNames.get(toolId) || ''; }
  getAllToolIds() { return [...this._toolArgs.keys()]; }
  get finalReasoning() { return this._lastReasoning; }
}

// ─── Create chat session ──────────────────────────────────────

async function createChatSession(headers, model) {
  const resp = await fetch(`${QWEN_BASE_URL}/api/v2/chats/new`, {
    method: 'POST',
    headers: { ...headers, accept: 'application/json' },
    body: JSON.stringify({ chat: { title: 'New chat' } }),
  });
  const data = await resp.json();
  if (!data.success || !data.data?.id) {
    throw new Error(`Failed to create chat session: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.data.id;
}

// ─── Build chat request ───────────────────────────────────────

function buildChatRequest(chatId, model, content) {
  const msgId = randomUUID();
  return {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId,
    chat_mode: 't2t',
    model,
    messages: [{
      fid: msgId,
      parentId: null,
      childrenIds: [],
      role: 'user',
      content,
      user_action: 'send',
      files: undefined,
      timestamp: Math.floor(Date.now() / 1000),
      models: [model],
      chat_type: 't2t',
      feature_config: {
        thinking_enabled: true,
        output_schema: 'phase',
        research_mode: 'normal',
        auto_thinking: true,
        thinking_mode: 'Auto',
        thinking_format: 'summary',
        auto_search: false,
      },
      extra: { meta: { subChatType: 't2t' } },
      sub_chat_type: 't2t',
    }],
    timestamp: Math.floor(Date.now() / 1000),
  };
}

// ─── Main handler ─────────────────────────────────────────────

export async function handleChatCompletion(body) {
  const { model: requestedModel, messages, stream = false } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages is required and must be a non-empty array');
  }

  const modelId = resolveModel(requestedModel) || resolveModel(_config.defaultModel) || 'qwen3.7-plus';

  // Login
  const { jwt, cookies } = await login();
  const headers = buildHeaders(jwt, cookies);

  // Parse messages
  const { content } = parseIncomingMessages(messages);
  if (!content) throw new Error('No message content found');

  // Create chat session
  const chatId = await createChatSession(headers, modelId);
  console.log(`[chat] model=${modelId} chat=${chatId} stream=${!!stream}`);

  // Send completion request
  const reqBody = buildChatRequest(chatId, modelId, content);
  const resp = await fetch(`${QWEN_BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(reqBody),
  });

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => '');
    throw new Error(`Chat completion failed: ${resp.status} ${errorText.slice(0, 200)}`);
  }

  const responseId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    return streamChat(resp, modelId, responseId, created);
  }
  return collectChat(resp, modelId, responseId, created);
}

// ─── Streaming ────────────────────────────────────────────────

async function* streamChat(resp, model, responseId, created) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const mapper = new DeltaMapper();
  let emittedFinish = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trimStart();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          if (parsed['response.created']) continue;

          if (parsed?.error) {
            const errMsg = parsed.error.message || parsed.error.details || 'Request failed';
            yield {
              id: responseId, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { role: 'assistant', content: errMsg }, finish_reason: 'stop' }],
            };
            emittedFinish = true;
            continue;
          }

          // Tool-result deltas (role: function) carry search results and
          // generated images. Extract image URLs to emit as content; skip
          // the rest (we don't forward search result text as content).
          const upstreamDelta = parsed?.choices?.[0]?.delta;
          if (upstreamDelta?.role === 'function') {
            const imageUrls = extractImageUrlsFromDelta(upstreamDelta);
            for (const imgUrl of imageUrls) {
              const md = `![image](${proxyImageUrl(imgUrl, _config)})`;
              yield {
                id: responseId, object: 'chat.completion.chunk', created, model,
                choices: [{ index: 0, delta: { role: 'assistant', content: md }, finish_reason: null }],
              };
            }
            continue;
          }

          const mapped = mapper.map(parsed);
          if (!mapped) continue;

          const { delta, finishReason } = mapped;
          const usage = parsed?.usage;

          if (Object.keys(delta).length > 0 || finishReason) {
            if (finishReason === 'stop' && mapper.hadToolCalls) {
              // If we had tool calls but the stream ends with an answer,
              // the real finish reason is "stop" (answer completed).
            }
            yield {
              id: responseId, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: delta || {}, finish_reason: finishReason }],
              ...(usage ? { usage: mapUsageToOpenAI(usage) } : {}),
            };
            if (finishReason === 'stop') emittedFinish = true;
          }
        } catch {}
      }
    }

    // If upstream ended without a finish_reason, emit one
    if (!emittedFinish) {
      const fr = mapper.hadToolCalls ? 'tool_calls' : 'stop';
      yield {
        id: responseId, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: {}, finish_reason: fr }],
      };
    }
  } finally {
    reader.releaseLock?.();
  }
}

// ─── Non-streaming ────────────────────────────────────────────

async function collectChat(resp, model, responseId, created) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const contentParts = [];
  const mapper = new DeltaMapper();
  let usage = null;
  let finalFinishReason = 'stop';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        if (parsed['response.created']) continue;
        if (parsed?.usage) usage = parsed.usage;

        // Extract image URLs from tool-result deltas (role: function)
        const upstreamDelta = parsed?.choices?.[0]?.delta;
        if (upstreamDelta?.role === 'function') {
          for (const imgUrl of extractImageUrlsFromDelta(upstreamDelta)) {
            contentParts.push(`![image](${proxyImageUrl(imgUrl, _config)})`);
          }
          continue;
        }

        const mapped = mapper.map(parsed);
        if (!mapped) continue;
        if (mapped.delta?.content) contentParts.push(mapped.delta.content);
        if (mapped.finishReason === 'stop') finalFinishReason = 'stop';
        if (mapped.finishReason === 'tool_calls') finalFinishReason = 'tool_calls';
      } catch {}
    }
  }

  const content = contentParts.join('');
  const reasoning = mapper.finalReasoning;

  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;

  // Build tool_calls from the mapper's final cumulative state
  if (mapper.hadToolCalls && mapper.getAllToolIds().length > 0) {
    const toolCalls = mapper.getAllToolIds().map(id => ({
      id, type: 'function',
      function: {
        name: mapper.getToolCallName(id),
        arguments: mapper.getToolCallArgs(id),
      },
    }));
    message.tool_calls = toolCalls;
    finalFinishReason = 'tool_calls';
  }

  return {
    id: responseId, object: 'chat.completion', created, model,
    choices: [{
      index: 0,
      message,
      finish_reason: finalFinishReason,
    }],
    usage: mapUsageToOpenAI(usage),
  };
}
