// Shared OpenAI-compatible provider quirks, so every enricher can target MiMo
// (or Gemini's OpenAI endpoint, or DeepSeek) from the same LLM_* config.
//
// MiMo (api.xiaomimimo.com) accepts the standard Bearer header but documents an
// `api-key` header too (we send both), and expects `max_completion_tokens`
// rather than `max_tokens`. Detection is by base URL, so flipping LLM_BASE_URL
// is all it takes to switch a stream to MiMo.

export function isMimoBase(baseUrl) {
  return /xiaomimimo/i.test(baseUrl || '');
}

/** Headers for an OpenAI-compatible /chat/completions call, MiMo-aware. */
export function compatHeaders(baseUrl, apiKey) {
  return {
    'Authorization': `Bearer ${apiKey}`,
    ...(isMimoBase(baseUrl) ? { 'api-key': apiKey } : {}),
    'Content-Type': 'application/json',
  };
}

/** The max-output token field, named per provider. Spread into the request body. */
export function tokenParam(baseUrl, maxTokens) {
  return isMimoBase(baseUrl)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}
