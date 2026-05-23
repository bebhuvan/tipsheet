import { createHash } from 'node:crypto';

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

// Content hash of a radar item — used to skip LLM calls when nothing has changed
// since the last run. Keyed on inputs the LLM sees: the symbol, trigger, evidence
// filings, and the fundamental flags. Title and score are intentionally excluded
// (the score is a noisy derived metric; the title is templated).
export function radarItemHash(item) {
  const evi = (item.evidence_record_ids || []).slice().map(Number).sort((a, b) => a - b).join(',');
  const q = (item.quality_flags || []).slice().sort().join('|');
  const r = (item.risk_flags    || []).slice().sort().join('|');
  return createHash('sha1')
    .update(`${item.symbol}|${item.trigger_type}|${evi}|${q}|${r}`)
    .digest('hex').slice(0, 16);
}

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}

function includesAny(text, patterns) {
  const s = String(text || '').toLowerCase();
  return patterns.some(p => s.includes(p));
}

function fmtCr(n) {
  if (n == null) return null;
  if (n >= 100000) return `Rs ${(n / 100000).toFixed(2)} lakh cr`;
  return `Rs ${Number(n).toLocaleString('en-IN')} cr`;
}

function qualityFlags(row) {
  const flags = [];
  if (row.roe != null && row.roe >= 15) flags.push(`ROE ${Number(row.roe).toFixed(1)}%`);
  if (row.debt_to_equity != null && row.debt_to_equity <= 0.5) flags.push(`low debt/equity ${Number(row.debt_to_equity).toFixed(2)}x`);
  if (row.free_cash_flow != null && row.free_cash_flow > 0) flags.push(`positive free cash flow (${fmtCr(row.free_cash_flow)})`);
  if (row.revenue_growth != null && row.revenue_growth >= 15) flags.push(`revenue growth ${Number(row.revenue_growth).toFixed(1)}%`);
  if (row.pat_growth != null && row.pat_growth >= 15) flags.push(`PAT growth ${Number(row.pat_growth).toFixed(1)}%`);
  if (row.dividend_yield != null && row.dividend_yield >= 2) flags.push(`dividend yield ${Number(row.dividend_yield).toFixed(1)}%`);
  return flags;
}

function riskFlags(row) {
  const flags = [];
  if (row.debt_to_equity != null && row.debt_to_equity >= 1.5) flags.push(`debt/equity ${Number(row.debt_to_equity).toFixed(2)}x`);
  if (row.free_cash_flow != null && row.free_cash_flow < 0) flags.push(`negative free cash flow (${fmtCr(Math.abs(row.free_cash_flow))})`);
  if (row.pat_growth != null && row.pat_growth < 0) flags.push(`PAT growth ${Number(row.pat_growth).toFixed(1)}%`);
  if (row.pe != null && row.pe >= 60) flags.push(`P/E ${Number(row.pe).toFixed(1)}x`);
  return flags;
}

function evidenceIds(rows, max = 5) {
  return rows.slice(0, max).map(r => r.record_id);
}

function baseScore(rows, qFlags, rFlags) {
  const maxScore = Math.max(...rows.map(r => r.score || 0));
  const leadCount = rows.filter(r => r.score >= 7).length;
  const alertCount = rows.filter(r => r.score >= 9).length;
  return clamp(
    maxScore * 7 +
    Math.min(rows.length, 5) * 4 +
    leadCount * 4 +
    alertCount * 10 +
    qFlags.length * 3 -
    rFlags.length * 2
  );
}

function makeItem({ rows, triggerType, title, whyNow, bonus = 0, qFlags, rFlags }) {
  const latest = rows[0];
  const score = clamp(baseScore(rows, qFlags, rFlags) + bonus);
  return {
    symbol: latest.symbol,
    company: latest.company,
    trigger_type: triggerType,
    title,
    why_now: whyNow,
    evidence_record_ids: evidenceIds(rows),
    quality_flags: qFlags,
    risk_flags: rFlags,
    radar_score: score,
    tijori_slug: latest.tijori_slug || null,
    status: 'active',
  };
}

function buildItemsForCompany(rows, concallFlag) {
  const latest = rows[0];
  const company = latest.company || latest.symbol;
  const qFlags = qualityFlags(latest);
  const rFlags = riskFlags(latest);
  const items = [];

  const leadRows = rows.filter(r => r.score >= 7);
  const orderRows = rows.filter(r =>
    r.major_order === 1 ||
    r.canonical_category === 'Order Wins' ||
    r.event_category_canonical === 'Order Wins'
  );
  const smartRows = rows.filter(r =>
    r.famous_investor_meeting === 1 ||
    r.canonical_category === 'M&A' ||
    includesAny(`${r.event_type} ${r.event_category_raw}`, ['pledge', 'warrant', 'acquisition', 'merger', 'designated person', 'promoter'])
  );

  if (orderRows.length) {
    const order = orderRows[0];
    const size = order.major_order_size ? ` The disclosed size is ${order.major_order_size}.` : '';
    items.push(makeItem({
      rows: orderRows.concat(rows.filter(r => !orderRows.includes(r))).slice(0, 5),
      triggerType: 'order_win',
      title: `${company}: fresh order flow to inspect`,
      whyNow: `${company} has reported a fresh order or award.${size} The question for readers is whether this is routine backlog replenishment or a signal of improving execution visibility.`,
      bonus: 10,
      qFlags,
      rFlags,
    }));
  }

  if (smartRows.length) {
    items.push(makeItem({
      rows: smartRows.concat(rows.filter(r => !smartRows.includes(r))).slice(0, 5),
      triggerType: 'smart_money',
      title: `${company}: ownership or control signal`,
      whyNow: `${company} has a promoter, investor, acquisition, pledge, warrant, or related ownership signal in the recent filing trail. That makes the next step a governance and capital-allocation check, not a price call.`,
      bonus: 12,
      qFlags,
      rFlags,
    }));
  }

  if (concallFlag) {
    items.push(makeItem({
      rows,
      triggerType: 'concall_watch',
      title: `${company}: management commentary needs a second read`,
      whyNow: `A recent Tijori Concall Monitor flag points to a management-consistency question. Radar is surfacing it so readers can compare the call trail with the filing trail.`,
      bonus: 12,
      qFlags,
      rFlags: uniq([...rFlags, 'management consistency flag']),
    }));
  }

  if (leadRows.length || rows.length >= 3) {
    const activity = rows.length === 1 ? 'one recent filing' : `${rows.length} recent filings`;
    items.push(makeItem({
      rows,
      triggerType: 'filing_cluster',
      title: `${company}: filing activity cluster`,
      whyNow: `${company} has ${activity} on Tipsheet's recent tape, including ${leadRows.length} Lead-or-higher item${leadRows.length === 1 ? '' : 's'}. That is enough activity to justify a structured review of the company timeline.`,
      bonus: rows.length >= 3 ? 8 : 4,
      qFlags,
      rFlags,
    }));
  }

  if (qFlags.length >= 2 && (leadRows.length || latest.score >= 7)) {
    items.push(makeItem({
      rows,
      triggerType: 'quality_breakout',
      title: `${company}: quality screen meets fresh disclosure`,
      whyNow: `${company} combines a recent material disclosure with fundamentals that pass a basic quality screen. Radar is flagging it for research because the operating profile and the news flow now overlap.`,
      bonus: 8,
      qFlags,
      rFlags,
    }));
  }

  return items;
}

export function buildRadarItems(sourceRows, concallFlags = [], { limit = 80 } = {}) {
  const grouped = new Map();
  for (const row of sourceRows) {
    if (!row.symbol) continue;
    if (!grouped.has(row.symbol)) grouped.set(row.symbol, []);
    grouped.get(row.symbol).push(row);
  }

  const concallBySymbol = new Map();
  for (const flag of concallFlags) {
    if (!flag.symbol || concallBySymbol.has(flag.symbol)) continue;
    concallBySymbol.set(flag.symbol, flag);
  }

  const items = [];
  for (const [symbol, rows] of grouped) {
    rows.sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)));
    items.push(...buildItemsForCompany(rows, concallBySymbol.get(symbol)));
  }

  return items
    .sort((a, b) => b.radar_score - a.radar_score || a.symbol.localeCompare(b.symbol))
    .slice(0, limit);
}
