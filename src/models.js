/**
 * Qwen model catalog.
 *
 * Models fetched from chat.qwen.ai/api/models (public endpoint).
 * Static fallback from the Qwen CLI presets.
 */

const QWEN_BASE_URL = 'https://chat.qwen.ai';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// ─── Static fallback ──────────────────────────────────────────

export const MODELS = {
  'qwen3.7-plus':               { contextSize: 1_000_000, enableThinking: true,  vision: true,  tier: 'free' },
  'qwen3.7-max':                { contextSize: 1_000_000, enableThinking: true,  vision: false, tier: 'free' },
  'qwen3.6-plus':               { contextSize: 1_000_000, enableThinking: true,  vision: true,  tier: 'free' },
  'qwen3.6-max-preview':        { contextSize: 1_000_000, enableThinking: true,  vision: false, tier: 'free' },
  'qwen3.6-27b':                { contextSize: 131_072,   enableThinking: false, vision: false, tier: 'free' },
  'qwen3.5-plus':               { contextSize: 1_000_000, enableThinking: true,  vision: true,  tier: 'free' },
  'qwen3.5-flash':              { contextSize: 1_000_000, enableThinking: true,  vision: false, tier: 'free' },
  'qwen3.5-omni-plus':          { contextSize: 1_000_000, enableThinking: true,  vision: true,  tier: 'free' },
  'qwen3.5-omni-flash':         { contextSize: 1_000_000, enableThinking: true,  vision: true,  tier: 'free' },
  'qwen3.5-max-2026-03-08':     { contextSize: 1_000_000, enableThinking: true,  vision: false, tier: 'free' },
  'qwen3.5-27b':                { contextSize: 131_072,   enableThinking: false, vision: false, tier: 'free' },
  'qwen3.5-35b-a3b':            { contextSize: 131_072,   enableThinking: false, vision: false, tier: 'free' },
  'qwen3.5-397b-a17b':          { contextSize: 131_072,   enableThinking: false, vision: false, tier: 'free' },
  'qwen3.5-122b-a10b':          { contextSize: 131_072,   enableThinking: false, vision: false, tier: 'free' },
  'qwen3-max-2026-01-23':       { contextSize: 262_144,   enableThinking: true,  vision: false, tier: 'free' },
  'qwen-plus-2025-07-28':       { contextSize: 131_072,   enableThinking: false, vision: false, tier: 'free' },
  'qwen3-coder-plus':           { contextSize: 1_000_000, enableThinking: false, vision: false, tier: 'free' },
  'qwen3-vl-plus':              { contextSize: 131_072,   enableThinking: false, vision: true,  tier: 'free' },
  'qwen3-omni-flash-2025-12-01':{ contextSize: 131_072,   enableThinking: true,  vision: true,  tier: 'free' },
  'qwen3.6-plus-preview':       { contextSize: 1_000_000, enableThinking: true,  vision: true,  tier: 'free' },
};

// ─── Resolution ──────────────────────────────────────────────

const _lookup = new Map();
for (const id of Object.keys(MODELS)) {
  _lookup.set(id, id);
  _lookup.set(id.toLowerCase(), id);
}

export function resolveModel(name) {
  if (!name) return null;
  return _lookup.get(name) || _lookup.get(name.toLowerCase()) || null;
}

// ─── List models (fetch from API, fall back to static) ───────

let _cachedModels = null;
let _cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

export async function listModels() {
  const now = Date.now();
  if (_cachedModels && (now - _cacheTime) < CACHE_TTL) return _cachedModels;

  try {
    const resp = await fetch(`${QWEN_BASE_URL}/api/models`, {
      headers: { 'Accept': 'application/json', 'User-Agent': UA },
    });
    if (resp.ok) {
      const data = await resp.json();
      const models = (data.data || []).map(m => ({
        id: m.id,
        name: m.name || m.id,
        object: 'model',
        created: 1700000000,
        owned_by: 'qwen',
      }));
      if (models.length > 0) {
        _cachedModels = models;
        _cacheTime = now;
        return models;
      }
    }
  } catch (err) {
    console.error('[models] Failed to fetch from API:', err.message);
  }

  return Object.entries(MODELS).map(([id]) => ({
    id, object: 'model', created: 1700000000, owned_by: 'qwen',
  }));
}
