/**
 * Qwen Slurp — OpenAI-compatible proxy + Qwen Web UI reverse proxy.
 *
 * - /v1/* → OpenAI-compatible API (for programmatic clients)
 * - everything else → reverse proxy to chat.qwen.ai with JWT injection
 *   (serves the real Qwen SPA with auth, mocked user routes, SSE toggle)
 */

import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync, createWriteStream, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { listModels } from './models.js';
import { handleChatCompletion } from './chat.js';
import { handleWebUI } from './webui.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Logging to .logs/server.log ──────────────────────────────
const logsDir = resolve(__dirname, '../.logs');
if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
const logStream = createWriteStream(resolve(logsDir, 'server.log'), { flags: 'a' });
const origLog = console.log;
const origErr = console.error;
function stamp() { return new Date().toISOString().slice(0, 19); }
console.log = (...args) => { origLog(...args); logStream.write(`[${stamp()}] ${args.join(' ')}\n`); };
console.error = (...args) => { origErr(...args); logStream.write(`[${stamp()}] ERR ${args.join(' ')}\n`); };

// ─── Prevent nul file creation (Git Bash compat) ──────────────
const nulPath = resolve(__dirname, '../nul');
if (existsSync(nulPath)) { try { unlinkSync(nulPath); } catch {} }

// ─── Config ───────────────────────────────────────────────────

function loadConfig() {
  const configPath = resolve(__dirname, '../.config/config.json');
  let cfg = {};
  if (existsSync(configPath)) {
    try { cfg = JSON.parse(readFileSync(configPath, 'utf-8')); } catch {}
  }
  return {
    port: parseInt(process.env.PORT || cfg.port || '3008', 10),
    defaultModel: cfg.defaultModel || 'qwen3-coder-plus',
    qwenLogin: cfg.qwenLogin || {},
  };
}

// ─── HTTP helpers ─────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolveP, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolveP(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function jsonResponse(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': '*',
    'Access-Control-Allow-Headers': '*',
  });
  res.end(JSON.stringify(data));
}

function sseWrite(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ─── Request router ───────────────────────────────────────────

async function handleRequest(req, res, config) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }

  // ── OpenAI API: GET /v1/models ──────────────────────────────
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const models = await listModels();
    return jsonResponse(res, 200, { object: 'list', data: models });
  }

  // ── OpenAI API: POST /v1/chat/completions ──────────────────
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.model) body.model = config.defaultModel;

      console.log(`[req] POST /v1/chat/completions model=${body.model} msgs=${body.messages?.length || 0} stream=${!!body.stream}`);

      const result = await handleChatCompletion(body);

      if (body.stream && typeof result[Symbol.asyncIterator] === 'function') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        for await (const chunk of result) {
          sseWrite(res, chunk);
        }
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      return jsonResponse(res, 200, result);
    } catch (err) {
      console.error(`[req] Error: ${err.message}`);
      return jsonResponse(res, 500, {
        error: { message: err.message, type: 'server_error' },
      });
    }
  }

  // ── OpenAI API: GET /health ────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/health') {
    return jsonResponse(res, 200, { status: 'ok' });
  }

  // ── Everything else → Qwen Web UI reverse proxy ────────────
  return handleWebUI(req, res, url);
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  console.log('=== Qwen Slurp Proxy Server ===');

  const hasLogin = !!config.qwenLogin?.email;
  console.log(`Mode: ${hasLogin ? 'authenticated (desktop API + JWT)' : 'guest (UI only — login required)'}`);

  const server = createServer((req, res) => handleRequest(req, res, config));
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`\nServer listening on http://127.0.0.1:${config.port}`);
    console.log(`\nEndpoints:`);
    console.log(`  GET  /v1/models              — OpenAI: list models`);
    console.log(`  POST /v1/chat/completions     — OpenAI: chat (stream supported)`);
    console.log(`  GET  /health                  — server status`);
    console.log(`  GET  /                        — Qwen Web UI (real SPA)`);
    console.log(`  GET  /c/:chatId               — Qwen Web UI (specific chat)`);
    console.log(`\nUsage:`);
    console.log(`  Open http://127.0.0.1:${config.port}/ in your browser`);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
