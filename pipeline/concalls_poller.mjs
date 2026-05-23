// Tijori Concall Monitor poller.
//
// Design notes (deliberately avoids the weaknesses of poller.mjs):
//   • AbortController timeout per request (15s default).
//   • Exponential backoff retry: 3 attempts, 500ms / 2s / 8s delays. Honours Retry-After
//     on HTTP 429. Network errors retry; 4xx (except 429) fail fast.
//   • Pagination via offset → next_offset cursor from the response itself. Caller passes
//     a budget (max items per run) so we don't exhaust the API in one go.
//   • Shape validation on every item — required fields (isin, event_time) are enforced;
//     missing items are skipped with a single warning rather than crashing the batch.
//   • Idempotent storage: PRIMARY KEY (isin, event_time) means INSERT OR IGNORE is safe.
//   • Symbol mapping: Tijori gives isin + slug; we map to our local NSE symbol via the
//     fundamentals table (isin → symbol). If unmapped, we store the slug and isin only —
//     the page will still render at /concalls/{slug}/{date}/.

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES    = 3;
const BACKOFF_BASE_MS    = 500;
const BACKOFF_FACTOR     = 4;
const DEFAULT_PAGE_SIZE  = 50;     // API max is 100; 50 balances chunk size vs latency.

function getConfig() {
  const apiKey  = process.env.TIJORI_CONCALLS_API_KEY;
  const baseUrl = process.env.TIJORI_CONCALLS_BASE_URL || 'https://www.tijoristack.ai/api/v1';
  if (!apiKey)  throw new Error('TIJORI_CONCALLS_API_KEY is not set');
  if (!baseUrl) throw new Error('TIJORI_CONCALLS_BASE_URL is not set');
  return { apiKey, baseUrl };
}

/**
 * Single HTTP GET with timeout. Returns { ok, status, body, retryAfterMs } — never throws
 * on HTTP errors so the caller's retry loop can inspect status codes.
 */
async function getJson(url, { apiKey, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept':        'application/json',
        'User-Agent':    'Tipsheet/concalls-poller',
      },
    });
    const retryAfter = r.headers.get('retry-after');
    const retryAfterMs = retryAfter ? Math.max(1, Number(retryAfter)) * 1000 : null;
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return { ok: false, status: r.status, body: text.slice(0, 500), retryAfterMs };
    }
    const body = await r.json();
    return { ok: true, status: r.status, body, retryAfterMs };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: e.name === 'AbortError' ? 'timeout' : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

/** GET with exponential-backoff retry. Returns the body on success or throws on final failure. */
async function getWithRetry(url, opts = {}) {
  const cfg = getConfig();
  const retries = opts.retries ?? DEFAULT_RETRIES;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await getJson(url, { apiKey: cfg.apiKey, timeoutMs: opts.timeoutMs });
    if (r.ok) return r.body;
    lastErr = r;
    // Fail fast on client errors that aren't rate-limiting
    if (r.status >= 400 && r.status < 500 && r.status !== 429) {
      throw new Error(`Concalls API ${r.status}: ${r.body?.slice?.(0, 200) || r.error}`);
    }
    if (attempt === retries) break;
    // Honour Retry-After if present, else exponential backoff
    const delay = r.retryAfterMs ?? BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, attempt);
    await new Promise(res => setTimeout(res, delay));
  }
  throw new Error(`Concalls API failed after ${retries + 1} attempts: ${lastErr.status} ${lastErr.error || lastErr.body?.slice?.(0, 200)}`);
}

/**
 * Validate a raw concall item from the list response. Returns null if invalid.
 * Required: company_info.isin, concall_event_time.
 */
function flattenConcall(item) {
  if (!item || typeof item !== 'object') return null;
  const ci = item.company_info || {};
  const isin = ci.isin;
  const event_time = item.concall_event_time;
  if (!isin || typeof isin !== 'string') return null;
  if (!event_time || typeof event_time !== 'string') return null;

  return {
    isin,
    event_time,
    company_name:           ci.name || null,
    sector:                 ci.sector || null,
    slug:                   ci.slug || null,
    status:                 item.status || null,
    recording_url:          item.recording_link || null,
    transcript_url:         item.transcript || null,
    transcript_source:      item.transcript_source || null,
    summary_highlight:      item.summary_highlight || null,
    management_consistency: item.management_consistency || null,
    ai_summary:             item.ai_summary || null,
    raw_json:               JSON.stringify(item),
  };
}

/**
 * Fetch a single page of concalls. Returns { items, pagination }. Items are flattened
 * and validated; invalid items are skipped (count surfaces in result.invalid_count).
 *
 * Filter params follow the OpenAPI spec at
 * https://www.tijoristack.ai/static/spec/v1/concalls.json
 */
export async function fetchConcallsPage({
  page = 1, page_size = DEFAULT_PAGE_SIZE,
  isin, mcap = 'all', sectors, tags, upcoming = false,
  timeoutMs, retries,
} = {}) {
  const { baseUrl } = getConfig();
  const qs = new URLSearchParams();
  qs.set('page', String(page));
  qs.set('page_size', String(page_size));
  if (isin) qs.set('isin', isin);
  if (mcap) qs.set('mcap', mcap);
  if (sectors)  for (const s of sectors)  qs.append('sectors', String(s));
  if (tags)     for (const t of tags)     qs.append('tags', String(t));
  if (upcoming) qs.set('upcoming', 'true');

  // Trailing slash required — Tijori 301s otherwise (Django convention)
  const url = `${baseUrl}/concalls/list/?${qs.toString()}`;
  const body = await getWithRetry(url, { timeoutMs, retries });

  const items = [];
  let invalid_count = 0;
  for (const item of (body.data || [])) {
    const flat = flattenConcall(item);
    if (!flat) { invalid_count++; continue; }
    items.push(flat);
  }
  return {
    items,
    invalid_count,
    pagination: body.pagination || {},
    active_filters: body.active_filters || {},
  };
}

/**
 * Paginated fetcher with budget. Yields rows in pages so the caller can persist as we go
 * (no all-or-nothing risk). Stops at maxItems or when pagination.next_offset is null.
 */
export async function* paginateConcalls({ maxItems = 200, ...filters } = {}) {
  let page = 1;
  let fetched = 0;
  while (fetched < maxItems) {
    const remaining = maxItems - fetched;
    const page_size = Math.min(100, Math.max(1, remaining));
    const result = await fetchConcallsPage({ page, page_size, ...filters });
    yield result;
    fetched += result.items.length;
    const next = result.pagination.next_offset;
    if (next == null || result.items.length === 0) break;
    page++;
  }
}

/** Tags taxonomy ({ id, name }). Cheap; cache in caller. */
export async function fetchTags() {
  const { baseUrl } = getConfig();
  return getWithRetry(`${baseUrl}/concalls/tags/`);
}

/**
 * Sector master with curated `sector_pulse_summary` markdown reports. 72 sectors,
 * 60 have a pulse summary (Q4 FY26-style). Refresh weekly; data changes slowly.
 */
export async function fetchSectorMaster() {
  const { baseUrl } = getConfig();
  return getWithRetry(`${baseUrl}/core/sector-master/`);
}
