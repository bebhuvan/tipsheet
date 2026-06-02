import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || resolve('..', 'data', 'filings.db');
const ARTICLE_LIMIT = Number(process.env.CONTENT_CONTRACT_ARTICLE_LIMIT || 200);

const failures = [];
const warnings = [];

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function parseJson(value, fallback, label) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    fail(`${label}: invalid JSON`);
    return fallback;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    fail(`${label}: expected array`);
    return [];
  }
  return value;
}

if (!existsSync(DB_PATH)) {
  console.error(`[content] database not found: ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

for (const table of ['filings_raw', 'filings_enriched', 'briefings']) {
  const found = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  if (!found) fail(`missing required table: ${table}`);
}

if (!failures.length) {
  const articles = db.prepare(`
    SELECT r.record_id, r.symbol, r.company, r.created_on,
           e.headline, e.dek, e.the_number_value, e.the_number_label,
           e.whats_new, e.what_were_watching, e.faqs, e.slug
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE e.validation_ok = 1
    ORDER BY r.created_on DESC
    LIMIT ?
  `).all(ARTICLE_LIMIT);

  for (const row of articles) {
    const label = `article ${row.record_id}`;
    for (const field of ['symbol', 'company', 'headline', 'dek', 'the_number_value', 'the_number_label']) {
      if (!isNonEmptyString(row[field])) fail(`${label}: missing ${field}`);
    }

    const whatsNew = parseJson(row.whats_new, [], `${label}.whats_new`);
    const watching = parseJson(row.what_were_watching, [], `${label}.what_were_watching`);
    const faqs = parseJson(row.faqs, [], `${label}.faqs`);
    if (!requireArray(whatsNew, `${label}.whats_new`).length) fail(`${label}: whats_new is empty`);
    if (!requireArray(watching, `${label}.what_were_watching`).length) fail(`${label}: what_were_watching is empty`);
    if (!requireArray(faqs, `${label}.faqs`).length) fail(`${label}: faqs is empty`);
  }

  const validArticleIds = new Set(db.prepare(`
    SELECT r.record_id
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE e.validation_ok = 1
  `).all().map(r => Number(r.record_id)));

  const briefings = db.prepare(`
    SELECT type, date, headline, dek, the_take, sections, validation_ok
    FROM briefings
    WHERE validation_ok = 1
    ORDER BY date DESC, type ASC
  `).all();

  for (const row of briefings) {
    const label = `briefing ${row.type}:${row.date}`;
    if (!['open', 'close'].includes(row.type)) fail(`${label}: invalid type`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.date || ''))) fail(`${label}: invalid date`);
    for (const field of ['headline', 'dek', 'the_take']) {
      if (!isNonEmptyString(row[field])) fail(`${label}: missing ${field}`);
    }

    const body = parseJson(row.sections, null, `${label}.sections`);
    if (Array.isArray(body)) {
      warn(`${label}: legacy section shape`);
      continue;
    }
    if (!body || typeof body !== 'object') {
      fail(`${label}: sections must be an object or legacy array`);
      continue;
    }

    const events = requireArray(body.events, `${label}.events`);
    for (const [idx, event] of events.entries()) {
      const eventLabel = `${label}.events[${idx}]`;
      const filingId = Number(event?.filing_id);
      if (!Number.isFinite(filingId)) {
        fail(`${eventLabel}: missing filing_id`);
      } else if (!validArticleIds.has(filingId)) {
        fail(`${eventLabel}: filing_id ${filingId} does not resolve to a valid article`);
      }
      if (!isNonEmptyString(event?.prose)) fail(`${eventLabel}: missing prose`);
    }

    for (const key of ['day_map', 'concalls', 'mgmt_flags', 'calendar']) {
      if (body[key] != null) requireArray(body[key], `${label}.${key}`);
    }
  }
}

for (const message of warnings.slice(0, 50)) console.warn(`[content] warning: ${message}`);
if (warnings.length > 50) console.warn(`[content] warning: ...and ${warnings.length - 50} more`);

if (failures.length) {
  console.error(`[content] ${failures.length} content contract failure(s):`);
  for (const message of failures.slice(0, 100)) console.error(`  - ${message}`);
  if (failures.length > 100) console.error(`  ...and ${failures.length - 100} more`);
  process.exit(1);
}

console.log(`[content] ok: checked latest ${ARTICLE_LIMIT} articles and ${db.prepare('SELECT COUNT(*) AS c FROM briefings WHERE validation_ok = 1').get().c} briefings`);
