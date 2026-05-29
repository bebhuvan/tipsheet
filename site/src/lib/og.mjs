// Build-time OG image generator.
// Renders a minimal editorial card to PNG via resvg — warm paper, an inset
// hairline frame, a Newsreader headline, and a quiet ticker/wordmark footer.
// Flat by design: no gradients, blurs, or shadows, so each card renders in
// ~120ms (a blurred design pushed this to ~5s/image and stalled the build).

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
    // Newsreader roman, latin (+ latin-ext for the ₹ rupee glyph)
    'cY9AfjOCX1hbuyalUrK4397yjA.woff2',
    'cY9AfjOCX1hbuyalUrK439DyjJBG.woff2',
    'cY9AfjOCX1hbuyalUrK439HyjJBG.woff2',
    // Newsreader italic, latin
    'cY9CfjOCX1hbuyalUrK439vCjohC.woff2',
    // JetBrains Mono, latin (500 + 400)
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

// Editorial palette.
const PAPER = '#FCFBF8';
const INK = '#16130F';
const MUTED = '#9A948C';
const HAIR = '#E4DFD6';
const ACCENT = '#B5341E'; // brand crimson

// Greedy word-wrap to <= maxChars per line.
function wrapAt(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) { line = word; continue; }
    if ((line.length + 1 + word.length) > maxChars) { lines.push(line); line = word; }
    else line += ' ' + word;
  }
  if (line) lines.push(line);
  return lines;
}

// Fit the whole headline by stepping the size down until it fits in <= maxLines.
// Newsreader averages ~0.50em per glyph; content width is ~1000px.
function fitHeadline(text, { width = 1000, maxLines = 3, sizes = [78, 70, 62, 56] } = {}) {
  for (const size of sizes) {
    const cpl = Math.floor(width / (size * 0.50));
    const lines = wrapAt(text, cpl);
    if (lines.length <= maxLines) return { lines, size, lh: Math.round(size * 1.12) };
  }
  // Last resort: smallest size, allow 4 lines, ellipsize the overflow.
  const size = sizes[sizes.length - 1];
  const lines = wrapAt(text, Math.floor(width / (size * 0.50)));
  if (lines.length > 4) { lines.length = 4; lines[3] = lines[3].replace(/[.,;:]?$/, '…'); }
  return { lines, size, lh: Math.round(size * 1.12) };
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

function headlineTspans(lines, x, lh) {
  return lines.map((ln, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : lh}">${esc(ln)}</tspan>`).join('');
}

// Wordmark lockup: a small triangle "tip" + "Tipsheet", left-anchored.
function wordmark(x, baseline, size = 34) {
  const t = baseline - size * 0.16;
  return `<path d="M ${x} ${t} l ${(size * 0.18).toFixed(1)} -${(size * 0.30).toFixed(1)} l ${(size * 0.18).toFixed(1)} ${(size * 0.30).toFixed(1)} Z" fill="${ACCENT}"/>
  <text x="${(x + size * 0.62).toFixed(1)}" y="${baseline}" font-family="Newsreader" font-size="${size}" font-weight="500" letter-spacing="-0.4" fill="${INK}">Tipsheet</text>`;
}

// Per-article card. 1200×630. Type-led, framed, one accent.
export function ogSvg({ headline, tier = 'Lead', sector = '', ticker = '', exchange = '' }) {
  const { lines, size, lh } = fitHeadline(headline);
  const startY = 248 - (lines.length >= 3 ? 0 : 8);
  const isAlert = String(tier).toLowerCase() === 'alert';
  const dot = isAlert ? `<circle cx="96" cy="140" r="5" fill="${ACCENT}"/>` : '';
  const kickerX = isAlert ? 116 : 90;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${PAPER}"/>
  <rect x="34" y="34" width="1132" height="562" rx="10" fill="none" stroke="${HAIR}" stroke-width="1.5"/>
  ${dot}
  <text x="${kickerX}" y="146" font-family="JetBrains Mono" font-size="18" font-weight="500" letter-spacing="3" fill="${INK}">${esc(String(tier).toUpperCase())}${sector ? `<tspan fill="${MUTED}" font-weight="400" dx="14">· ${esc(String(sector).toUpperCase())}</tspan>` : ''}</text>
  <text x="90" y="${startY}" font-family="Newsreader" font-size="${size}" font-weight="450" fill="${INK}" letter-spacing="-1.4">${headlineTspans(lines, 90, lh)}</text>
  <text x="92" y="556" font-family="JetBrains Mono" font-size="17" font-weight="500" letter-spacing="2.2" fill="${INK}">${esc(String(ticker).toUpperCase())}${exchange ? `<tspan fill="${MUTED}" font-weight="400" dx="16">${esc(exchange)}</tspan>` : ''}</text>
  ${wordmark(962, 558)}
</svg>`;
}

// Brand fallback card — homepage and index pages. Same plate, centered lockup.
export function brandSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${PAPER}"/>
  <rect x="34" y="34" width="1132" height="562" rx="10" fill="none" stroke="${HAIR}" stroke-width="1.5"/>
  <path d="M 600 222 L 617 252 L 583 252 Z" fill="${ACCENT}"/>
  <text x="600" y="392" text-anchor="middle" font-family="Newsreader" font-size="150" font-weight="500" letter-spacing="-4" fill="${INK}">Tipsheet</text>
  <text x="600" y="446" text-anchor="middle" font-family="Newsreader" font-style="italic" font-size="24" font-weight="300" fill="${MUTED}">What matters at India’s listed companies</text>
  <text x="600" y="520" text-anchor="middle" font-family="JetBrains Mono" font-size="15" font-weight="500" letter-spacing="4" fill="${ACCENT}">ALERT · LEAD · BRIEF</text>
</svg>`;
}

// Organisation logo — square 1000×1000, used by NewsMediaOrganization.logo,
// every NewsArticle publisher.logo, and the JSON feed icon. Google requires a
// reachable publisher logo for news rich results; a flat wordmark on paper
// renders fast and matches the OG cards. Declared dimensions everywhere that
// references /logo.png MUST stay 1000×1000 to match this output.
export function logoSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000">
  <rect width="1000" height="1000" fill="${PAPER}"/>
  <path d="M 500 372 L 532 426 L 468 426 Z" fill="${ACCENT}"/>
  <text x="500" y="588" text-anchor="middle" font-family="Newsreader" font-size="132" font-weight="500" letter-spacing="-3" fill="${INK}">Tipsheet</text>
  <text x="500" y="648" text-anchor="middle" font-family="JetBrains Mono" font-size="22" font-weight="500" letter-spacing="6" fill="${ACCENT}">INDIA · LISTED</text>
</svg>`;
}

// Render any SVG to a PNG buffer. Width defaults to the 1200px OG card; pass a
// width matching the SVG's intrinsic size for square assets (e.g. the logo).
export function renderPng(svg, { width = 1200 } = {}) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: {
      fontBuffers: FONT_BUFFERS,
      loadSystemFonts: false,
      defaultFontFamily: 'Newsreader',
    },
    background: PAPER,
  });
  return resvg.render().asPng();
}
