// OG image generator — v3 layout.
// Refinements over v2: drop URL, add italic dek under headline, bigger hero number,
// refined wordmark with accent rule, more breathing room.

import { Resvg } from '@resvg/resvg-js';
import Database from 'better-sqlite3';
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_NAME, BRAND_TAGLINE } from '../src/lib/brand.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, '../../data/filings.db');
const RECORD_ID = Number(process.argv[2]) || 93403;

const db = new Database(DB_PATH, { readonly: true });
const filing = db.prepare(`
  SELECT r.record_id, r.symbol, r.company, r.score, r.created_on,
         e.headline, e.dek, e.canonical_category, e.the_number_value, e.the_number_label
  FROM filings_raw r JOIN filings_enriched e ON e.record_id = r.record_id
  WHERE e.validation_ok = 1 AND r.record_id = ?
`).get(RECORD_ID);
db.close();
if (!filing) { console.error('No filing found for', RECORD_ID); process.exit(1); }

function tierFor(score) {
  if (score >= 9) return { label: 'ALERT',  color: '#b4321e' };
  if (score >= 7) return { label: 'STORY',  color: '#1a1a1a' };
  return                  { label: 'UPDATE', color: '#7a7a7a' };
}
const tier = tierFor(filing.score);

function wrap(text, maxChars) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars && line) { lines.push(line); line = w; }
    else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  return lines;
}

const headlineLines = wrap(filing.headline, 30).slice(0, 3);
const dekLines      = wrap(filing.dek || '', 56).slice(0, 2);
const labelLines    = wrap(filing.the_number_label || '', 22).slice(0, 3);
const dateStr       = (() => {
  const d = new Date(String(filing.created_on).replace(' ', 'T'));
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return Number.isNaN(d.valueOf()) ? '' : `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
})();

const numberValue = filing.the_number_value || '';
const numLen = numberValue.length;
const numberSize = numLen <= 6 ? 112 : numLen <= 8 ? 96 : numLen <= 12 ? 78 : numLen <= 16 ? 62 : 52;

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── layout ──────────────────────────────────────────────────────────
const W = 1200, H = 630;
const M = 72;
const RIGHT_X = 780;

// Headline starts higher so we have room for the dek beneath
const KICKER_Y     = 198;
const HEADLINE_Y   = 252;
const HEADLINE_LH  = 56;
const DEK_GAP      = 28;

const NUMBER_LABEL_Y = 198;
const NUMBER_Y       = 296;
const NUMBER_HINT_GAP = 36;

const FOOTER_RULE_Y = 558;
const FOOTER_TEXT_Y = 590;

// ─── SVG ─────────────────────────────────────────────────────────────
const dekY = HEADLINE_Y + (headlineLines.length - 1) * HEADLINE_LH + DEK_GAP;

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <!-- background: warm paper -->
  <rect width="${W}" height="${H}" fill="#fbf8f0"/>

  <!-- left edge accent stripe in tier colour -->
  <rect x="0" y="0" width="6" height="${H}" fill="${tier.color}"/>

  <!-- wordmark + accent rule + date stamp -->
  <text x="${M}" y="84" font-family="Georgia, 'Times New Roman', serif" font-size="34" font-weight="700" fill="#1a1a1a" letter-spacing="-0.5">${esc(BRAND_NAME)}.</text>
  <line x1="${M}" y1="96" x2="${M + 44}" y2="96" stroke="${tier.color}" stroke-width="2"/>
  <text x="${M}" y="120" font-family="Georgia, serif" font-size="12" font-style="italic" fill="#7a7a7a" letter-spacing="0.4">${esc(BRAND_TAGLINE)}</text>

  <text x="${W - M}" y="84" font-family="ui-monospace, 'SF Mono', Menlo, monospace" font-size="12" fill="#999" text-anchor="end" letter-spacing="3">${esc(dateStr.toUpperCase())}</text>
  <text x="${W - M}" y="104" font-family="ui-monospace, monospace" font-size="11" fill="#bcb7ac" text-anchor="end" letter-spacing="3">EDITION №&#160;145</text>

  <!-- kicker line (left column) -->
  <text x="${M}" y="${KICKER_Y}" font-family="ui-monospace, 'SF Mono', Menlo, monospace" font-size="13" font-weight="700" fill="#1a1a1a" letter-spacing="3">
    <tspan>${esc(filing.symbol)}</tspan><tspan fill="#d4cfc2">    </tspan><tspan fill="#666">${esc(filing.canonical_category?.toUpperCase() || '')}</tspan>
  </text>

  <!-- headline -->
  ${headlineLines.map((line, i) => `<text x="${M}" y="${HEADLINE_Y + i * HEADLINE_LH}" font-family="Georgia, 'Times New Roman', serif" font-size="44" font-weight="500" fill="#1a1a1a" letter-spacing="-0.3">${esc(line)}</text>`).join('\n  ')}

  <!-- dek (italic, small, muted) -->
  ${dekLines.map((line, i) => `<text x="${M}" y="${dekY + i * 26}" font-family="Georgia, serif" font-size="18" font-style="italic" fill="#5a5a5a">${esc(line)}</text>`).join('\n  ')}

  <!-- vertical hairline between columns -->
  <line x1="${RIGHT_X - 36}" y1="${NUMBER_LABEL_Y - 20}" x2="${RIGHT_X - 36}" y2="${FOOTER_RULE_Y - 24}" stroke="#e6e0d2" stroke-width="1"/>

  <!-- right column: THE NUMBER -->
  <text x="${RIGHT_X}" y="${NUMBER_LABEL_Y}" font-family="ui-monospace, monospace" font-size="10" fill="#999" letter-spacing="4">THE NUMBER</text>
  <text x="${RIGHT_X}" y="${NUMBER_Y}" font-family="Georgia, 'Times New Roman', serif" font-size="${numberSize}" font-weight="500" fill="${tier.color}" letter-spacing="-1">${esc(numberValue)}</text>

  <!-- number label, italic serif, multi-line -->
  ${labelLines.map((line, i) => `<text x="${RIGHT_X}" y="${NUMBER_Y + NUMBER_HINT_GAP + i * 26}" font-family="Georgia, serif" font-size="17" font-style="italic" fill="#3a3a3a">${esc(line)}</text>`).join('\n  ')}

  <!-- footer rule + minimal bottom strip -->
  <line x1="${M}" y1="${FOOTER_RULE_Y}" x2="${W - M}" y2="${FOOTER_RULE_Y}" stroke="#1a1a1a" stroke-width="0.5"/>

  <!-- tier badge (dot + label) -->
  <circle cx="${M + 5}" cy="${FOOTER_TEXT_Y - 4}" r="4" fill="${tier.color}"/>
  <text x="${M + 18}" y="${FOOTER_TEXT_Y}" font-family="ui-monospace, monospace" font-size="12" font-weight="700" fill="${tier.color}" letter-spacing="4">${tier.label}</text>

  <!-- filing score on right -->
  <text x="${W - M}" y="${FOOTER_TEXT_Y}" font-family="ui-monospace, monospace" font-size="12" fill="#7a7a7a" text-anchor="end" letter-spacing="3">FILING SCORE  <tspan fill="#1a1a1a" font-weight="700">${filing.score}/10</tspan></text>
</svg>`;

const resvg = new Resvg(svg, { background: '#fbf8f0', fitTo: { mode: 'width', value: W } });
const png = resvg.render().asPng();
const out = '/tmp/sample-og-v3.png';
await writeFile(out, png);
console.log('Wrote', out, '—', png.length, 'bytes');
