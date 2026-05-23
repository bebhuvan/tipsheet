// Build-time OG image generator.
// Renders a hand-tuned SVG composition to PNG via resvg.
// One template, three tiers (Alert/Lead/Brief), per-article fill.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = path.resolve(__dirname, '..', '..', 'public', 'fonts');

// Load only the basic-latin subsets we need so resvg has the right glyphs.
// (The Vietnamese / latin-ext files are not needed for our English copy.)
function loadFontBuffers() {
  const wanted = [
    // Newsreader roman, latin
    'cY9AfjOCX1hbuyalUrK4397yjA.woff2',
    'cY9AfjOCX1hbuyalUrK439DyjJBG.woff2',  // latin-ext fallback
    // Newsreader italic, latin
    'cY9CfjOCX1hbuyalUrK439vCjohC.woff2',
    // JetBrains Mono, latin (any 500/400)
    'tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPx_cwhsk.woff2',
    'tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxPcwhsk.woff2',
  ];
  const buffers = [];
  for (const f of wanted) {
    const p = path.join(FONTS_DIR, f);
    if (fs.existsSync(p)) buffers.push(fs.readFileSync(p));
  }
  return buffers;
}

const FONT_BUFFERS = loadFontBuffers();

// Wrap a string into N lines that each fit within ~maxChars. Conservative — Newsreader
// at 76px averages ~0.55em per glyph, so 22 chars ≈ 920px (fits 1040px content area).
function wrap(text, maxChars = 22, maxLines = 3) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) { line = word; continue; }
    if ((line.length + 1 + word.length) > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line += ' ' + word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const truncated = lines.slice(0, maxLines);
    truncated[maxLines - 1] = truncated[maxLines - 1].replace(/[.,;:]?$/, '…');
    return truncated;
  }
  return lines;
}

// Escape text for safe inclusion in SVG markup.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function tierColor(tier) {
  if (tier === 'Alert') return '#b5341e';
  if (tier === 'Lead')  return '#111111';
  return '#6a6a6a'; // Brief
}

// Pure SVG. 1200×630. Type-led, left-aligned, single accent rule.
// No clichés: no gradients, no shadows, no scattered ornaments, no faded letters.
// Just typography, a thin rule, and one accent mark.
export function ogSvg({ headline, tier = 'Lead', sector = '', ticker = '', edition = '' }) {
  const lines = wrap(headline, 22, 3);
  const lineHeight = 88;
  const headlineStartY = 240;
  const headlineBlockHeight = lines.length * lineHeight;
  const ruleY = headlineStartY + headlineBlockHeight + 24;
  const footerY = 580;

  const tierLabel = String(tier || '').toUpperCase();
  const sectorLabel = sector ? ' · ' + String(sector).toUpperCase() : '';
  const tierFill = tierColor(tier);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#ffffff"/>

  <!-- Top accent rule + tier label -->
  <rect x="80" y="118" width="32" height="2" fill="#b5341e"/>
  <text x="128" y="128"
        font-family="JetBrains Mono"
        font-size="20"
        font-weight="500"
        letter-spacing="3.4"
        fill="${tierFill}">${esc(tierLabel)}<tspan fill="#9a9a9a" font-weight="400">${esc(sectorLabel)}</tspan></text>

  <!-- Headline -->
  <text x="80" y="${headlineStartY}"
        font-family="Newsreader"
        font-size="76"
        font-weight="400"
        fill="#111111"
        letter-spacing="-2">
${lines.map((ln, i) => `    <tspan x="80" dy="${i === 0 ? 0 : lineHeight}">${esc(ln)}</tspan>`).join('\n')}
  </text>

  <!-- Hairline divider above footer -->
  <line x1="80" y1="${footerY - 40}" x2="1120" y2="${footerY - 40}" stroke="#d8d8d8" stroke-width="1"/>

  <!-- Footer: ticker (left) · wordmark (right) -->
  <text x="80" y="${footerY}"
        font-family="JetBrains Mono"
        font-size="18"
        font-weight="500"
        letter-spacing="3"
        fill="#111111">${esc(String(ticker || '').toUpperCase())}</text>

  ${edition ? `<text x="80" y="${footerY + 22}" font-family="Newsreader" font-style="italic" font-size="14" font-weight="300" fill="#9a9a9a">${esc(edition)}</text>` : ''}

  <!-- Wordmark — a small upward triangle (the "tip") above the brand name (the "sheet") -->
  <path d="M 1100 ${footerY - 18} L 1107 ${footerY - 8} L 1093 ${footerY - 8} Z" fill="#b5341e"/>
  <text x="1120" y="${footerY}"
        text-anchor="end"
        font-family="Newsreader"
        font-size="40"
        font-weight="400"
        letter-spacing="-1"
        fill="#111111">Tipsheet</text>
  <text x="1120" y="${footerY + 22}"
        text-anchor="end"
        font-family="Newsreader"
        font-style="italic"
        font-size="14"
        font-weight="300"
        fill="#9a9a9a">An editorial reading of India’s listed companies</text>
</svg>`;
}

// Brand fallback card — for the homepage and index pages.
export function brandSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#ffffff"/>
  <line x1="80"   y1="120" x2="1120" y2="120" stroke="#d8d8d8" stroke-width="1"/>
  <text x="600" y="180"
        text-anchor="middle"
        font-family="Newsreader"
        font-style="italic"
        font-size="22"
        font-weight="300"
        fill="#6a6a6a">An editorial reading of India’s listed companies.</text>
  <!-- Brand mark: triangle "tip" above the wordmark "sheet" -->
  <path d="M 600 220 L 620 256 L 580 256 Z" fill="#b5341e"/>
  <text x="600" y="380"
        text-anchor="middle"
        font-family="Newsreader"
        font-size="160"
        font-weight="400"
        letter-spacing="-5"
        fill="#111111">Tipsheet</text>
  <text x="600" y="440"
        text-anchor="middle"
        font-family="JetBrains Mono"
        font-size="14"
        font-weight="500"
        letter-spacing="2.6"
        fill="#b5341e">ALERT · LEAD · BRIEF</text>
  <line x1="80"   y1="510" x2="1120" y2="510" stroke="#d8d8d8" stroke-width="1"/>
  <text x="600" y="558"
        text-anchor="middle"
        font-family="Newsreader"
        font-style="italic"
        font-size="16"
        font-weight="300"
        fill="#6a6a6a">tipsheet.in</text>
</svg>`;
}

// Render any SVG to a PNG buffer at 1200×630.
export function renderPng(svg) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
    font: {
      fontBuffers: FONT_BUFFERS,
      loadSystemFonts: false,
      defaultFontFamily: 'Newsreader',
    },
    background: 'white',
  });
  return resvg.render().asPng();
}
