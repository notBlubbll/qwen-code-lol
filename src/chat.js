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

function mapUpstreamDeltaToOpenAI(delta) {
  if (!delta || typeof delta !== 'object') return null;
  const mapped = {};
  if (delta.role === 'assistant') mapped.role = delta.role;
  if (typeof delta.content === 'string') mapped.content = delta.content;
  const reasoning = extractReasoningContentFromDelta(delta);
  if (reasoning) mapped.reasoning_content = reasoning;

  // Translate Qwen's function_call → OpenAI tool_calls
  // Qwen sends: { function_call: { name, arguments }, function_id }
  // OpenAI expects: { tool_calls: [{ id, type: "function", function: { name, arguments } }] }
  if (delta.function_call) {
    const fnName = delta.function_call.name || '';
    const fnArgs = typeof delta.function_call.arguments === 'string'
      ? delta.function_call.arguments
      : JSON.stringify(delta.function_call.arguments || {});
    if (fnName) {
      mapped.tool_calls = [{
        index: 0,
        id: delta.function_id || `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: { name: fnName, arguments: fnArgs },
      }];
    }
  }

  return Object.keys(mapped).length > 0 ? mapped : null;
}

function mapUsageToOpenAI(usage) {
  return {
    prompt_tokens: Number(usage?.input_tokens || 0),
    completion_tokens: Number(usage?.output_tokens || 0),
    total_tokens: Number(usage?.total_tokens || 0),
  };
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
            continue;
          }

          const delta = mapUpstreamDeltaToOpenAI(parsed?.choices?.[0]?.delta);
          let finishReason = parsed?.choices?.[0]?.finish_reason || null;

          // When a function call completes, map finish to "tool_calls"
          if (delta?.tool_calls && !finishReason) {
            // Tool call in progress — no finish yet
          }
          // Qwen sends status: "finished" with phase: "web_search" etc.
          // When the function result comes back (role: "function"), don't emit as tool_calls
          if (delta?.role === 'function') {
            // This is a tool result — pass as content for compatibility
            continue;
          }

          if (delta || finishReason) {
            // If we had tool calls and now finishing, use "tool_calls" finish reason
            if (finishReason === 'stop' && delta?.tool_calls) {
              finishReason = 'tool_calls';
            }
            yield {
              id: responseId, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: delta || {}, finish_reason: finishReason }],
              ...(parsed?.usage ? { usage: mapUsageToOpenAI(parsed.usage) } : {}),
            };
          }
        } catch {}
      }
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
  const reasoningParts = [];
  const toolCalls = []; // { id, function: { name, arguments } }
  let usage = null;
  let hadToolCalls = false;

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

        const delta = mapUpstreamDeltaToOpenAI(parsed?.choices?.[0]?.delta);
        if (delta?.content) contentParts.push(delta.content);
        if (delta?.reasoning_content) reasoningParts.push(delta.reasoning_content);
        if (delta?.tool_calls) {
          hadToolCalls = true;
          for (const tc of delta.tool_calls) {
            // Merge arguments across chunks for the same tool call
            const existing = toolCalls.find(t => t.id === tc.id);
            if (existing) {
              existing.function.arguments += tc.function.arguments;
            } else {
              toolCalls.push({ ...tc });
            }
          }
        }
      } catch {}
    }
  }

  const content = contentParts.join('');
  const reasoning = reasoningParts.join('');

  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  if (hadToolCalls) {
    message.tool_calls = toolCalls.map(tc => ({
      id: tc.id, type: 'function', function: tc.function,
    }));
  }

  return {
    id: responseId, object: 'chat.completion', created, model,
    choices: [{
      index: 0,
      message,
      finish_reason: hadToolCalls ? 'tool_calls' : 'stop',
    }],
    usage: mapUsageToOpenAI(usage),
  };
}
