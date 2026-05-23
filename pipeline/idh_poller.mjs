// India Data Hub poller.
//
// API spec: https://feeds.indiadatahub.com/openapi.json
// Auth: ?api_key={KEY} query parameter
// 51 endpoints across 11 categories; for V1 we wire the two most editorially useful:
//
//   /newsfeed/calendar  — scheduled economic events (date, country, indicator, period,
//                         previous, forecast, actual, impact). Feeds the Open/Close briefings:
//                         "Today: India CPI at 17:30; consensus 5.2% YoY, prior 5.4%."
//
//   /em/categories      — taxonomy of Economic Monitor indicators (35 top-level cats).
//   /em/filter          — indicator catalogue (with frequency, unit).
//   /em/data            — time-series data for a specific indicator.
//
// Same hardened pattern as concalls_poller: AbortController timeout, exponential backoff
// honouring Retry-After, per-item validation. Returns structured results.

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES    = 3;
const BACKOFF_BASE_MS    = 500;
const BACKOFF_FACTOR     = 4;

function getConfig() {
  const apiKey  = process.env.INDIA_DATAHUB_API_KEY;
  const baseUrl = process.env.INDIA_DATAHUB_BASE_URL || 'https://feeds.indiadatahub.com';
  if (!apiKey)  throw new Error('INDIA_DATAHUB_API_KEY is not set');
  return { apiKey, baseUrl };
}

async function getJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'Filings/idh-poller (https://filings.in)' },
    });
    const retryAfter = r.headers.get('retry-after');
    const retryAfterMs = retryAfter ? Math.max(1, Number(retryAfter)) * 1000 : null;
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return { ok: false, status: r.status, body: text.slice(0, 500), retryAfterMs };
    }
    return { ok: true, status: r.status, body: await r.json(), retryAfterMs };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function getWithRetry(path, queryParams = {}, opts = {}) {
  const { apiKey, baseUrl } = getConfig();
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const qs = new URLSearchParams({ api_key: apiKey, ...queryParams });
  const url = `${baseUrl}${path}?${qs.toString()}`;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await getJson(url, { timeoutMs: opts.timeoutMs });
    if (r.ok) return r.body;
    lastErr = r;
    if (r.status >= 400 && r.status < 500 && r.status !== 429) {
      throw new Error(`IDH API ${r.status}: ${r.body?.slice?.(0, 200) || r.error}`);
    }
    if (attempt === retries) break;
    const delay = r.retryAfterMs ?? BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, attempt);
    await new Promise(res => setTimeout(res, delay));
  }
  throw new Error(`IDH API failed after ${retries + 1} attempts: ${lastErr?.status} ${lastErr?.error || lastErr?.body?.slice?.(0, 200)}`);
}

/**
 * Calendar of scheduled economic events. IDH returns paginated results with
 * { _meta: { page, per_page, total_pages, total_items }, dataset: [...] }.
 * Each item: { Date, Coverage, Identifier, Indicator, Period, Previous, Forecast, Actual,
 *              Category, Unit, Frequency, Impact, DateType, Event_Flag, Country_Code }
 */
export async function fetchCalendar({ from_date, to_date, country_code = null, page = 1, per_page = 100 } = {}) {
  const params = { page, per_page };
  if (from_date) params.from_date = from_date;
  if (to_date)   params.to_date   = to_date;
  if (country_code) params.country_code = country_code;
  const body = await getWithRetry('/newsfeed/calendar', params);
  return {
    meta: body._meta || {},
    events: Array.isArray(body.dataset) ? body.dataset : [],
  };
}

/** Paginate the calendar; yields page objects. */
export async function* paginateCalendar(opts = {}) {
  let page = opts.page || 1;
  while (true) {
    const result = await fetchCalendar({ ...opts, page });
    yield result;
    const meta = result.meta;
    if (!meta.total_pages || page >= meta.total_pages || result.events.length === 0) break;
    page++;
  }
}

/** Economic Monitor categories: { CategoryName: ['SubCat1', 'SubCat2', ...] }. */
export async function fetchEMCategories() {
  return getWithRetry('/em/categories');
}

/** Economic Monitor indicators in a category. */
export async function fetchEMIndicators({ category, subcategory = null, region = null } = {}) {
  const params = {};
  if (category)    params.category    = category;
  if (subcategory) params.subcategory = subcategory;
  if (region)      params.region      = region;
  return getWithRetry('/em/filter', params);
}

/** Time-series data for a specific indicator identifier. */
export async function fetchEMData({ identifier, region = null, from_date = null, to_date = null } = {}) {
  if (!identifier) throw new Error('identifier required');
  const params = { identifier };
  if (region)    params.region    = region;
  if (from_date) params.from_date = from_date;
  if (to_date)   params.to_date   = to_date;
  return getWithRetry('/em/data', params);
}

/**
 * Validate a calendar event from /newsfeed/calendar. Returns null if invalid.
 * Required: Date, Indicator. We tolerate missing Identifier (some events have no series id).
 */
export function flattenCalendarEvent(item) {
  if (!item || typeof item !== 'object') return null;
  if (!item.Date || !item.Indicator) return null;
  return {
    date:          item.Date,
    coverage:      item.Coverage || null,
    identifier:    item.Identifier || null,
    indicator:     item.Indicator,
    period:        item.Period || null,
    previous_val:  item.Previous ?? null,
    forecast_val:  item.Forecast ?? null,
    actual_val:    item.Actual ?? null,
    category:      item.Category || null,
    unit:          item.Unit || null,
    frequency:     item.Frequency || null,
    impact:        item.Impact || null,           // H / M / L
    date_type:     item.DateType || null,         // A = actual, T = tentative
    event_flag:    item.Event_Flag ? 1 : 0,
    country_code:  item.Country_Code || null,
    raw_json:      JSON.stringify(item),
  };
}
