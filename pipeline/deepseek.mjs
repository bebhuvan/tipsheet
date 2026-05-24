// DeepSeek API harness — one robust, reusable transport for all DeepSeek-backed enrichment
// (RBI, circulars-on-DeepSeek, legal orders, etc.). Docs: https://api-docs.deepseek.com/
//
// Why centralise: every source needs the same plumbing — JSON-mode output, exponential backoff
// on 429/5xx, timeouts, and usage/cost (incl. cache-hit) tracking. Enrichers should own only
// their prompt + schema + validator, and call chatJson() here.
//
// MODELS (post-2026): 'deepseek-v4-flash' (cheap, default) | 'deepseek-v4-pro' (harder tasks).
//   The legacy 'deepseek-chat' / 'deepseek-reasoner' names DEPRECATE 2026-07-24 — do not use.
//
// CONTEXT CACHING: DeepSeek auto-caches identical request PREFIXES. Keep the system prompt
//   byte-stable across calls and it bills cache-hit tokens ~10x cheaper. We surface
//   prompt_cache_hit_tokens / prompt_cache_miss_tokens so callers can see the hit rate.
//
// JSON MODE: response_format {type:'json_object'} requires the word "json" somewhere in the
//   messages (OpenAI-compatible rule). Our system prompts already say "Return ONLY JSON".

const BASE_URL   = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS || 60_000);
const MAX_RETRIES = Number(process.env.DEEPSEEK_MAX_RETRIES || 4);
const BACKOFF_BASE_MS = 800;

export class DeepSeekError extends Error {
  constructor(message, { status = 0, code = null, retryable = false } = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status; this.code = code; this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function isRetryable(status) { return status === 429 || status === 500 || status === 502 || status === 503; }

function buildMessages({ system, user, messages }) {
  if (Array.isArray(messages) && messages.length) return messages;
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  if (user) out.push({ role: 'user', content: user });
  return out;
}

/**
 * Low-level chat call with retries/backoff/timeout. Returns:
 *   { ok, content, finish_reason, usage, model, elapsed_ms, attempts }  on success
 *   { ok:false, error, status, code, attempts }                          on failure
 */
export async function chat({
  system, user, messages,
  model = DEFAULT_MODEL,
  jsonMode = true,
  temperature = 0.4,
  maxTokens = 1500,
  thinking = false,
  reasoningEffort = 'high',
  timeoutMs = TIMEOUT_MS,
  maxRetries = MAX_RETRIES,
} = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return { ok: false, error: 'missing DEEPSEEK_API_KEY', status: 0, attempts: 0 };

  const body = {
    model,
    messages: buildMessages({ system, user, messages }),
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  if (thinking) { body.thinking = { type: 'enabled' }; body.reasoning_effort = reasoningEffort; }

  const t0 = Date.now();
  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        let code = null; try { code = JSON.parse(txt)?.error?.code ?? null; } catch {}
        lastErr = { status: r.status, code, body: txt.slice(0, 300) };
        if (isRetryable(r.status) && attempt <= maxRetries) {
          const ra = Number(r.headers.get('retry-after'));
          await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : BACKOFF_BASE_MS * 2 ** (attempt - 1));
          continue;
        }
        return { ok: false, error: `deepseek ${r.status}${code ? ` (${code})` : ''}`, status: r.status, code, attempts: attempt };
      }
      const j = await r.json();
      const choice = j.choices?.[0];
      return {
        ok: true,
        content: choice?.message?.content ?? '',
        reasoning: choice?.message?.reasoning_content ?? null,
        finish_reason: choice?.finish_reason ?? null,
        usage: shapeUsage(j.usage),
        model: j.model || model,
        elapsed_ms: Date.now() - t0,
        attempts: attempt,
      };
    } catch (e) {
      lastErr = { status: 0, error: e.name === 'AbortError' ? 'timeout' : (e.message || 'network error') };
      if (attempt <= maxRetries) { await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1)); continue; }
      return { ok: false, error: lastErr.error || 'network error', status: 0, attempts: attempt };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: `failed after ${maxRetries + 1} attempts: ${lastErr?.error || lastErr?.status}`, status: lastErr?.status || 0, attempts: maxRetries + 1 };
}

function shapeUsage(u) {
  if (!u) return null;
  const hit = u.prompt_cache_hit_tokens ?? 0;
  const miss = u.prompt_cache_miss_tokens ?? (u.prompt_tokens != null ? u.prompt_tokens - hit : 0);
  return {
    prompt_tokens: u.prompt_tokens ?? null,
    completion_tokens: u.completion_tokens ?? null,
    total_tokens: u.total_tokens ?? null,
    cache_hit_tokens: hit,
    cache_miss_tokens: miss,
    cache_hit_ratio: u.prompt_tokens ? +(hit / u.prompt_tokens).toFixed(2) : null,
  };
}

/**
 * JSON convenience: chat() in JSON mode + parse, with one automatic repair attempt if the
 * model returns non-JSON. Returns { ok, parsed, content, usage, model, elapsed_ms, error }.
 */
export async function chatJson(opts) {
  let last = null;
  // Up to 2 attempts: a malformed-JSON return is usually transient (long outputs get truncated
  // or wrapped), so re-requesting once recovers it — distinct from the transport retries in chat().
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await chat({ ...opts, jsonMode: true });
    if (!res.ok) return { ok: false, error: res.error, status: res.status, parsed: null };
    last = res;
    try {
      return { ...res, parsed: JSON.parse(res.content) };
    } catch {
      // Repair pass: some models wrap JSON in prose/fences despite json_object.
      const m = res.content.match(/\{[\s\S]*\}/);
      if (m) { try { return { ...res, parsed: JSON.parse(m[0]) }; } catch {} }
      // else fall through and re-request once
    }
  }
  return { ok: false, error: 'json_parse', content: last?.content?.slice(0, 300), parsed: null };
}

/** Pretty one-liner for logs, e.g. "1.9s · 1642 tok · cache 71%". */
export function usageLine(res) {
  const u = res?.usage;
  const parts = [`${((res?.elapsed_ms || 0) / 1000).toFixed(1)}s`];
  if (u?.total_tokens != null) parts.push(`${u.total_tokens} tok`);
  if (u?.cache_hit_ratio != null) parts.push(`cache ${Math.round(u.cache_hit_ratio * 100)}%`);
  if (res?.attempts > 1) parts.push(`${res.attempts} attempts`);
  return parts.join(' · ');
}

export const DEEPSEEK_MODEL = DEFAULT_MODEL;
