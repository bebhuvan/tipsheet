// Pure, browser-safe renderer for the async company-financials snapshot shown
// below filing articles. Fed the JSON payload from /api/widget/:symbol, which
// mirrors the Tijori SDK article_widget() shape:
//   { name, sector, market_cap_text, pe, statements: { <key>: { periods, metrics:[{metric_name, values:[{period, value}]}] } } }
// Returns an HTML string, or '' when there is nothing worth showing.
// No DOM / Node dependencies — safe to import from a client <script> and to unit test.

const fmtCr = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(n);
  if (abs >= 100000) return sign + '₹' + (abs / 100000).toFixed(2) + ' L cr';
  return sign + '₹' + Math.round(abs).toLocaleString('en-IN') + ' cr';
};
const fmtPct = (n) => (n != null && Number.isFinite(n)) ? (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(1) + '%' : '—';
const fmtNum = (n, d = 2) => (n != null && Number.isFinite(n)) ? n.toFixed(d) : '—';
const fmtRatio = (n) => (n != null && Number.isFinite(n)) ? n.toFixed(2) + '×' : '—';
const fmtRupee = (n) => (n != null && Number.isFinite(n)) ? (n < 0 ? '−₹' + Math.abs(n).toFixed(2) : '₹' + n.toFixed(2)) : '—';
const dirClass = (v) => (v == null || !Number.isFinite(v)) ? '' : (v >= 0 ? 'up' : 'down');

// market_cap_text from the SDK is a bare ₹-figure in crore (e.g. "₹8,76,078").
// Reformat to a readable, unit-bearing string so it can't be misread as rupees.
function fmtMarketCap(text) {
  if (!text) return '';
  const num = Number(String(text).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(num) || num <= 0) return null;
  return num >= 100000 ? '₹' + (num / 100000).toFixed(2) + ' L cr'
    : '₹' + Math.round(num).toLocaleString('en-IN') + ' cr';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Find a metric in the first matching statement.
//  - `names`   : the metric name(s) to look for (case-insensitive)
//  - `exact`   : require the name to equal one of `names`. Use for core P&L
//    lines (Net Sales / Operating Profit / Net Profit) so banks/insurers don't
//    surface look-alike line items like "Net Profit on Sale of Investments" or
//    "Operating Profit from Premiums". When false, matches by substring.
//  - `exclude` : substrings that disqualify a candidate (e.g. "margin").
function pickMetric(statements, keys, names, { exact = false, exclude = [] } = {}) {
  const lname = names.map((n) => n.toLowerCase());
  const lex = exclude.map((n) => n.toLowerCase());
  for (const key of keys) {
    const st = statements[key];
    if (!st || !Array.isArray(st.metrics)) continue;
    const candidates = st.metrics.filter((m) => {
      const n = String(m.metric_name || '').toLowerCase();
      if (lex.some((x) => n.includes(x))) return false;
      return exact ? lname.includes(n) : lname.some((x) => n.includes(x));
    });
    if (!candidates.length) continue;
    const m = candidates.find((c) => lname.includes(String(c.metric_name || '').toLowerCase())) || candidates[0];
    const vals = (m.values || []).filter((v) => v.value != null && v.value !== '' && Number.isFinite(Number(v.value)));
    if (!vals.length) continue;
    const latest = vals[vals.length - 1];
    const prev = vals.length > 1 ? vals[vals.length - 2] : null;
    return {
      name: m.metric_name,
      val: Number(latest.value),
      period: latest.period || '',
      prev: prev ? Number(prev.value) : null,
    };
  }
  return null;
}

function cell(label, valueHtml, dir) {
  return `<div class="cs-cell"><span class="cs-k">${esc(label)}</span><span class="cs-v${dir ? ' ' + dir : ''}">${valueHtml}</span></div>`;
}

// Free-text sector → metric profile. Only the financial buckets (where the
// generic P&L grid misleads — operating margin on a bank, current ratio on an
// NBFC) get special-cased; everything else uses the "generic" profile.
function sectorClass(sector) {
  const s = String(sector || '').toLowerCase();
  if (/\bbank/.test(s)) return 'bank';
  if (/insuranc|assuranc/.test(s)) return 'insurer';
  if (/nbfc|non.?banking|housing finance|financial services|asset management|broking|capital market|microfinance|lending/.test(s)) return 'nbfc';
  return 'generic';
}

// Ordered metric menu per profile. Each key references the cell map built
// below; any key whose metric is missing in the data is silently skipped, so
// the box only ever shows figures that actually exist for that company.
const PROFILE = {
  bank:    { quarter: ['np', 'npm', 'eps'],          strength: ['roe', 'gSales', 'gEps'],       strengthTitle: 'Returns & growth' },
  insurer: { quarter: ['np', 'npm', 'eps'],          strength: ['roe', 'gSales', 'gEps'],       strengthTitle: 'Returns & growth' },
  nbfc:    { quarter: ['sales', 'np', 'npm', 'eps'], strength: ['de', 'roe', 'gSales', 'gEps'], strengthTitle: 'Leverage & growth' },
  generic: { quarter: ['sales', 'np', 'opm', 'eps'], strength: ['de', 'cr', 'gSales', 'gEps'],  strengthTitle: 'Strength & growth' },
};

export function renderSnapshotHTML(widget, symbol, tijoriUrl) {
  if (!widget) return '';
  const w = widget;
  const st = w.statements || {};
  const sym = esc(symbol || '');
  const cls = sectorClass(w.sector);
  const yoy = (m) => (m && m.prev ? m.val / m.prev - 1 : null);

  // Latest quarter (consolidated then standalone). Exact match on the headline
  // P&L lines; substring match is safe for the margin metrics.
  const quarter = ['qt_c', 'qt_s'];
  const qSale = pickMetric(st, quarter, ['Net Sales'], { exact: true });
  const qPat  = pickMetric(st, quarter, ['Net Profit'], { exact: true });
  const qOpm  = pickMetric(st, quarter, ['Operating Profit Margin']);
  const qNpm  = pickMetric(st, quarter, ['Net Profit Margin']);
  const qEps  = pickMetric(st, quarter, ['EPS'], { exact: true });

  // Quality ratios, returns, and multi-year growth.
  const ratios = ['fr_c', 'fr_s'];
  const bsCr  = pickMetric(st, ratios, ['Current Ratio']);
  const bsDe  = pickMetric(st, ratios, ['Debt to Equity']);
  const roe   = pickMetric(st, ratios, ['ROE']);
  const gSale = pickMetric(st, ['growth'], ['Sales CAGR']);
  const gEps  = pickMetric(st, ['growth'], ['TTM EPS CAGR']);

  // Cell map keyed by the names the profiles reference. add() is a no-op when
  // the value is missing, so absent metrics simply never appear.
  const M = {};
  const add = (key, label, value, dir) => { if (value) M[key] = cell(label, value, dir); };
  add('sales', cls === 'nbfc' ? 'Total income' : 'Sales', qSale && fmtCr(qSale.val), dirClass(yoy(qSale)));
  add('np', 'Net profit', qPat && fmtCr(qPat.val), dirClass(yoy(qPat)));
  add('opm', 'Op. margin', qOpm && fmtPct(qOpm.val));
  add('npm', 'Net margin', qNpm && fmtPct(qNpm.val));
  add('eps', 'EPS', qEps && fmtRupee(qEps.val));
  add('roe', 'Return on equity', roe && fmtPct(roe.val), dirClass(roe ? roe.val : null));
  add('de', 'Debt / equity', bsDe && fmtRatio(bsDe.val));
  add('cr', 'Current ratio', bsCr && fmtRatio(bsCr.val));
  add('gSales', 'Sales CAGR', gSale && fmtPct(gSale.val), dirClass(gSale ? gSale.val : null));
  add('gEps', 'EPS CAGR', gEps && fmtPct(gEps.val), dirClass(gEps ? gEps.val : null));

  const prof = PROFILE[cls];
  const qKeys = prof.quarter.filter((k) => M[k]);
  const sKeys = prof.strength.filter((k) => M[k]);
  if (!qKeys.length && !sKeys.length) return '';

  const qPeriod = (qPat || qSale || qEps || qNpm || qOpm || {}).period || '';

  let html = '<section class="company-snapshot">';

  html += '<header class="cs-head"><div class="cs-id">'
    + '<div class="cs-kicker">Company snapshot</div>'
    + `<h2 class="cs-name">${esc(w.name || symbol)}</h2>`;
  if (w.sector) html += `<div class="cs-industry">${esc(w.sector)}</div>`;
  html += '</div><div class="cs-rank-block">';
  const mcap = fmtMarketCap(w.market_cap_text);
  if (mcap) html += `<div class="cs-market-cap">${mcap}</div>`;
  const pe = Number(w.pe);
  if (Number.isFinite(pe) && pe > 0 && pe < 1000) html += `<div class="cs-rank">P/E ${fmtNum(pe)}×</div>`;
  html += '</div></header>';

  html += '<div class="cs-groups">';
  if (qKeys.length) {
    html += `<div class="cs-group"><h3 class="cs-group-title">Latest quarter${qPeriod ? ` · ${esc(qPeriod)}` : ''}</h3>`
      + `<div class="cs-grid">${qKeys.map((k) => M[k]).join('')}</div></div>`;
  }
  if (sKeys.length) {
    html += `<div class="cs-group"><h3 class="cs-group-title">${esc(prof.strengthTitle)}</h3>`
      + `<div class="cs-grid">${sKeys.map((k) => M[k]).join('')}</div></div>`;
  }
  html += '</div>';

  html += '<footer class="cs-foot">'
    + '<span class="cs-asof">Financials via Tijori, loaded after the article — a research aid, not investment advice.</span>';
  if (tijoriUrl) html += `<a href="${esc(tijoriUrl)}" target="_blank" rel="noopener" class="cs-tijori">${sym} on Tijori</a>`;
  html += '</footer></section>';

  return html;
}
