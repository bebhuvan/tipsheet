// Fundamentals fetcher — Tijori Kite Screener.
// Returns one record per listed symbol with sector, market cap, P/E, ROE, etc.
// Source URL is a secret (treat like TIJORI_FEED_URL).

function getUrl() {
  const url = process.env.KITE_SCREENER_URL;
  if (!url) throw new Error('KITE_SCREENER_URL is not set in environment');
  return url;
}

export async function fetchFundamentals() {
  const r = await fetch(getUrl());
  if (!r.ok) throw new Error(`fundamentals HTTP ${r.status}`);
  const body = await r.json();
  return Array.isArray(body) ? body : (body.items || body.data || []);
}

// Sanity clamp: 99.98% of Kite Screener mcap values are in crores. A handful of
// rows leak in raw rupees (e.g. SCL: 1,202,709,560 = ~₹120 cr stored as rupees, not cr).
// Anything ≥ ₹50 lakh cr (5,000,000) is implausible — likely a unit error upstream.
// We treat any such value as raw-rupees and divide by 1e7 to convert to crores.
const MCAP_SANITY_CR = 5_000_000;  // ₹50 lakh cr ceiling for "in crores" interpretation

function normaliseMcap(raw) {
  const n = numOr(raw, null);
  if (n == null) return null;
  if (n >= MCAP_SANITY_CR) return n / 1e7;
  return n;
}

/** Normalise a raw row from Tijori into our row shape. */
export function flattenFundamental(row) {
  return {
    symbol:         row.symbol,
    isin:           row.isin || null,
    sector:         row.sector || null,
    market_cap:     normaliseMcap(row.mcap),
    pe:             numOr(row.pe, null),
    roe:            numOr(row.roe, null),
    debt_to_equity: numOr(row.debt_to_equity, null),
    dividend_yield: numOr(row.dividend_yield, null),
    free_cash_flow: numOr(row.free_cash_flow, null),
    revenue_growth: numOr(row.revenue_growth, null),
    pat_growth:     numOr(row.pat_growth, null),
    low_52w:        numOr(row.low_52w, null),
    high_52w:       numOr(row.high_52w, null),
    tijori_slug:    row.tijori_slug || row.slug || null,
    raw_json:       JSON.stringify(row),
  };
}

function numOr(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normaliseName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\bltd\.?\b/g, 'limited')
    .replace(/\blimited\b/g, 'limited')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Tijori company URLs use their internal slug, e.g.
 * /company/power-finance-corporation-limited/. Do not derive this by string
 * replacement: some companies use "-ltd" while others use "-limited".
 */
export async function resolveTijoriCompanySlug({ symbol, company }, { timeoutMs = 10_000 } = {}) {
  if (!company && !symbol) return null;

  const query = company || symbol;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `https://www.tijorifinance.com/api/v1/ind/company_search/?q=${encodeURIComponent(query)}`;
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Tipsheet/tijori-linker',
      },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows)) return null;

    const companies = rows.filter(row => ['companies', 'InActive'].includes(row.type) && row.slug);
    if (companies.length === 0) return null;

    const targetName = normaliseName(company);
    const exact = targetName ? companies.find(row => normaliseName(row.name) === targetName) : null;
    if (exact) return exact.slug;

    // A full company-name search usually returns one canonical result. Accept that
    // case, but avoid guessing from broad ticker searches like "MARUTI".
    if (company && companies.length === 1) return companies[0].slug;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
