# Tipsheet — Site Handoff

This file documents the **site/** Astro app — the design redesign, rebrand, font/OG/icon system, and SEO work done in the previous session. The broader project (data pipeline, LLM enrichment, etc.) has its own `HANDOFF.md` in the project root one level up; this file is **site-scoped only**.

---

## TL;DR

The publication was rebranded **Filings → Stories → Tipsheet**. Tier names rebranded **Alert/Story/Update → Alert/Lead/Brief**. The homepage was structurally redesigned (single-column lead → hero + rail + midtier + briefs + wire). Fonts are self-hosted. Per-article OG cards generated at build via resvg. Distinct brand mark (a brick-red triangle above a horizontal rule) ships as the favicon, apple-touch-icon, and PWA icon. The site is ready to deploy once the real domain is set.

---

## Brand

| | Value |
|---|---|
| `BRAND_NAME` | **Tipsheet** |
| `BRAND_TAGLINE` | *An editorial reading of India's listed companies.* |
| `ARTICLE_TYPE` / plural | *Story* / *Stories* (kept deliberately distinct from brand) |
| `EDITORIAL_BYLINE` | *Tipsheet Editorial* |
| Editorial tiers | **Alert** (score ≥ 9) / **Lead** (7–8) / **Brief** (5–6) |
| Numeric scores | **Never displayed** — tier names only, banded by colour |
| Site (placeholder) | `https://stories.example` — **needs replacement before deploy** (see `astro.config.mjs`) |

All brand text flows from `src/lib/brand.mjs`. Tier mapping is in `src/lib/queries.mjs` (`tierFor`) and mirrored client-side in `src/pages/index.astro` (`tierLabel`) and `src/pages/search.astro` (`tierName`).

---

## File map (the important ones)

```
site/
├── astro.config.mjs               # static mode, compressHTML, site URL (placeholder!)
├── package.json                   # better-sqlite3 + @resvg/resvg-js + astro
├── public/
│   ├── favicon.svg                # theme-aware brand mark (triangle + rule)
│   ├── site.webmanifest           # PWA installability
│   ├── robots.txt                 # AI-bot allow, sitemap refs
│   ├── llms.txt                   # AI citation guidance
│   ├── fonts/
│   │   ├── fonts.css              # @font-face declarations, self-hosted
│   │   └── *.woff2                # Newsreader variable + JBM + Inter subsets
│   └── sample-og.png              # legacy fallback (unused; OG now generated per-article)
├── src/
│   ├── lib/
│   │   ├── brand.mjs              # single source of brand truth
│   │   ├── queries.mjs            # SQLite queries; getHomepageBundle(), tierFor()
│   │   ├── og.mjs                 # SVG composition + resvg PNG render
│   │   └── icon.mjs               # icon PNG generator (192/512/180)
│   ├── layouts/
│   │   └── Base.astro             # head, schema, font preloads, icons, ⌘K shortcut
│   ├── components/
│   │   ├── Masthead.astro         # centered nameplate + nav (4 items)
│   │   ├── SiteFooter.astro       # 4-col footer with Browse moved here
│   │   ├── MarketBlock.astro      # /markets/ tables
│   │   └── Sparkline.astro        # /markets/ inline SVG sparklines
│   ├── styles/
│   │   └── global.css             # the design system (~1700 LOC)
│   └── pages/
│       ├── index.astro            # home: hero (lead + companions + rail) → midtier → briefs → wire
│       ├── [id].astro             # filing/story page; gutter (tier + fund-block + timeline) + body
│       ├── search.astro           # client-side filter against /search-index.json
│       ├── search-index.json.js   # flat index of filings + companies + sectors
│       ├── og/[id].png.js         # per-article 1200×630 PNG
│       ├── og/brand.png.js        # fallback brand OG
│       ├── apple-touch-icon.png.js, icon-192.png.js, icon-512.png.js
│       ├── filings/               # archive index + category + paged
│       ├── briefings/             # Open + Close
│       ├── concalls/              # earnings call notes
│       ├── company/[symbol]/      # per-company timeline
│       ├── sector/[slug]/         # per-sector pages
│       ├── markets.astro          # 200 KB page, 132 inline SVG sparklines
│       ├── companies.astro, sectors.astro, concalls.astro, smart-money.astro
│       ├── about, methodology, editorial-standards, corrections, ownership,
│       │   contact, privacy, terms                       # static editorial pages
│       ├── feed.xml.js, feed.json.js                     # RSS + JSON Feed
│       └── sitemap.xml.js, sitemap-news.xml.js           # discovery + Google News
```

---

## Design system

### Tokens (`src/styles/global.css`)

```
--bg, --bg-soft         backgrounds (light bg-soft is #f7f4ed warm; dark is #1c1916)
--text, --text-soft, --text-muted, --text-faint
--hairline, --hairline-strong, --border
--up: #1f5a3f / #6aa382          financial up
--down: #872a1a / #c97a6d        financial down
--accent: #b5341e / #de6347      brick red — used sparingly (ALERT tier, ornaments, hover)
--brief-open / --brief-close     The Open / The Close briefing colours
--selection / --selection-text
--serif: Newsreader, fallbacks
--mono:  JetBrains Mono, fallbacks
--data:  Inter, fallbacks                # financial-metric values only
--gutter: 56px
```

Dark mode via `[data-theme="dark"]`; respected by the theme toggle in the masthead utility cluster.

### Fonts

Self-hosted in `public/fonts/`. Three families, subset by unicode-range:

- **Newsreader** (variable, ital + opsz + wght) — body, headlines, deks, kickers (italic), nav, footer
- **JetBrains Mono** (400, 500) — tickers, dates, kicker meta strips
- **Inter** (400, 500, 600, with `tnum`/`lnum`/`cv11`) — financial-metric values **only** (fund-block, company-snapshot, range bar)

Critical italic + roman Newsreader basic-latin subsets are preloaded in `Base.astro`. The rest load via `font-display: swap`.

### Brand mark

A small **brick-red upward triangle** (the *tip*) sitting above a **horizontal rule** (the *sheet*). Encoded in two SVG paths. Lives in:

- `public/favicon.svg` (theme-aware: rule flips ivory in dark mode)
- `src/lib/icon.mjs` → rendered to PNG at 180/192/512
- `src/lib/og.mjs` → appears bottom-right on every per-article OG card; centered on the brand fallback card

### OG image system

`src/lib/og.mjs` composes a 1200×630 SVG per filing — left-aligned, type-led: accent rule → tier label (`ALERT`/`LEAD`/`BRIEF` + sector, banded colour) → 1–3 line Newsreader headline at 76px → hairline divider → ticker (left) + brand mark + wordmark + tagline (right).

`src/pages/og/[id].png.js` uses `getStaticPaths` to enumerate all filings and emits a static PNG per article at build via `@resvg/resvg-js` with font buffers passed in (so the headline renders in actual Newsreader, not a system fallback).

Schema integration: every `NewsArticle` JSON-LD in `[id].astro` carries `image: [{ImageObject 1200×630}]` pointing at the per-article PNG. OG meta tags too.

**Build cost:** ~2 minutes (492 PNGs × ~250ms each). One-time per daily rebuild — acceptable.

---

## Homepage structure (`src/pages/index.astro`)

In source order:

1. **Briefing ribbon** — two slim cards (The Close + The Open) above the masthead-line.
2. **Hero** (`section.hero`, 2-col grid 1.7fr / 1fr):
   - Left (`.hero-lead`): tier kicker → 56px serif headline → italic dek → meta strip → **lead-companions** (2 items below in a 2-col mini-grid).
   - Right (`.hero-rail`): **3** stacked `hero-sec` items with `border-left`, items separated by hairlines.
3. **Midtier** ("Also today"): 3×2 grid (6 items) with mixed categories, vertical hairline columns. Round-robin picker in `getHomepageBundle()` ensures mix.
4. **By section** (`section.briefs`): 2-col grid of category cards, each with display-italic heading, ticker-anchored items, italic "All earnings →" footer link.
5. **The Wire** (`section.wire-section`): full-width chronological list. Each row: time / tier text / kicker+headline / ticker, hover slides + accent.

Total above-fold density: ~9 visible items (1 lead + 2 companions + 3 hero-sec + 3 midtier on first viewport).

---

## Article page (`src/pages/[id].astro`)

```
Masthead
  ↓
.kicker (tier + category + sector breadcrumb)
.headline   (Newsreader 400, clamp(40, 5.4vw, 72px))
.dek        (italic 300, clamp(20, 1.8vw, 25px))
.timeline-cta   ←  prominent link to /company/<symbol>/ when prior stories exist
hr.rule
.dateline   (mono small caps)
.content (grid: 220px / 1px / 1fr, with centered hairline)
  ├── aside.gutter
  │     ├── .tier-block (serif italic word, banded)
  │     ├── .fund-block (At a glance + Inter metrics)
  │     └── .timeline    (Story so far — prior items in a list)
  └── div.body
        ├── .the-number (huge serif figure)
        ├── h2 sections (italic serif now, accent prefix rule)
        ├── ul.bullets
        ├── p body (Newsreader 20px / 1.65)
        ├── .entities (Mentioned: X · Y · Z)
        ├── .end-mark §
        └── .primary-source (BSE/NSE links)
section.company-snapshot
  ├── cs-head (name + Inter price + ▲/▼ change)
  ├── cs-range (52-week range bar with current-price marker)
  ├── cs-groups
  │     ├── "Size & valuation"  (Market cap, P/E×2, P/B, EPS, Div yield)
  │     ├── "Returns & risk"    (ROE, Op margin, Debt/equity, Beta)
  │     └── "Looking ahead"     (Analyst view, 12-mo target, Next earnings)
  │   Semantic colour: ROE/OpMargin ≥15% → up; ≤0 → down; D/E ≥1.5× → down; EPS<0 → down
  └── cs-foot ("At close on 22 May 2026." · "Public market data. Verify…")
SiteFooter
```

---

## SEO baseline (already done; don't break)

- `/sitemap.xml`, `/sitemap-news.xml` (48-hour cutoff per Google spec)
- `NewsMediaOrganization` schema sitewide (in `Base.astro`) with `ethicsPolicy`, `correctionsPolicy`, `verificationFactCheckingPolicy`, `ownershipFundingInfo`, `missionCoveragePrioritiesPolicy`, `masthead`, `actionableFeedbackPolicy` — exactly what Google's QRG looks for on YMYL finance
- `NewsArticle` schema per filing with `image`, `author`, `publisher`, `datePublished`, `dateModified`, `isBasedOn`, `citation`, `articleSection`, `keywords`, `about` (Corporation with tickerSymbol)
- `en-IN` + `x-default` hreflang
- `max-image-preview:large` (Discover gate)
- `robots.txt` explicitly allows GPTBot, ClaudeBot, PerplexityBot, OAI-SearchBot, ChatGPT-User, Google-Extended, Applebot, cohere-ai
- `llms.txt` for AI citation
- RSS (`/feed.xml`) + JSON Feed (`/feed.json`)

---

## Search

- `/search/` page with client-side filter (DOM-safe, no innerHTML)
- `/search-index.json` — 280 KB raw, ~50 KB gzipped (filings + companies + sectors)
- Masthead utility cluster: "Search ⌘K" link
- Global `⌘K`/`Ctrl+K` shortcut in `Base.astro` — navigates to `/search/` from anywhere (ignored inside inputs and on the search page itself)
- Index trimmed: `d` (dek) used only for matching (in `q`); `ti` (tier name) computed client-side from `sc`

---

## Build & deploy

```bash
cd site
npm install
npm run build       # ~2 min — generates 949 HTML pages + 492 OG PNGs + 3 icon PNGs
```

Output: `dist/` (22 MB total — mostly HTML, ~52 KB main CSS, ~280 KB search index, ~20 MB OG PNGs)

Static preview (the previous session ran one on port 8765):
```bash
python3 -m http.server 8765 --directory dist
```

### Before deploy
1. **Replace the placeholder domain** in `astro.config.mjs` (currently `https://stories.example`). All canonical URLs, sitemaps, schemas, og URLs derive from it. Suggested: `https://tipsheet.in`.
2. Set `Cache-Control: public, max-age=31536000, immutable` at the edge for `/fonts/*.woff2`, `/og/*.png`, `/favicon.svg`, `/icon-*.png`, `/apple-touch-icon.png`.
3. Set short cache (or no-cache) for HTML.
4. Submit `/sitemap-news.xml` to Google Search Console under News.
5. Go to Google Publisher Center → add publication → point at sitemap-news.xml for Google News inclusion.

---

## What's pending / known issues

### Domain & deploy hygiene
- **`astro.config.mjs` site URL is still `https://stories.example`** — must be replaced before deploy. RSS feed canonicals, sitemap loc URLs, OG image URLs, and schema URLs all derive from this.
- The `Editorial byline slug` URL is still `/authors/filings-editorial/` (intentional — URL kept for SEO continuity through the rebrand). The displayed byline is "Tipsheet Editorial." If you ever change the slug, add a 301 redirect.
- Site nav label says "Latest" but the URL is `/filings/`. SEO durable, label tells the reader what it is. Fine.

### Editorial copy
- Brand description in `lib/brand.mjs` (`BRAND_DESCRIPTION`) still reads *"editorial publication covering Indian-equity disclosures. Every Story is grounded in a primary source…"* — fine, but worth re-reading for tone post-rebrand.
- Static editorial pages (about, methodology, editorial-standards, ownership, terms, privacy) had their bare "Filings" / "Stories" brand refs replaced via sed, but the prose around them may read slightly stiff at the rebranded seams. Worth a manual read-through for grammar and voice (e.g., possessives, pronouns).

### Voice & content (upstream from design)
- Some Filing Notes have awkward deks ("The nano-cap's latest order ~3.4% of market cap adds to order book with government counterparty reducing risk.") — grammar/article problems. This is an **LLM prompt issue**, not a design one. See `pipeline/prompts/system.txt` in the project root; the editorial-voice memory has the rules.
- The "Other" category leak was fixed in kickers (suppressed when category is "Other"), but the underlying taxonomy could still be cleaned up upstream.

### Performance
- **Markets page is 200 KB** (132 inline SVG sparklines). Could lazy-render below-the-fold with IntersectionObserver. Not on the critical path — most arriving traffic lands on article pages.
- **Search index is 280 KB raw / ~50 KB gzipped.** Acceptable for `/search/` only. Could be split by type and lazy-loaded if pressure ever arises.
- **Build time is ~2 min** because of 492 OG PNG renders. Acceptable for daily rebuild. Could parallelize the resvg renders if it becomes a problem.

### Design / dust
- Some dead CSS may remain (~48 KB main bundle). Was pruned heavily but a final pass through unused selectors wouldn't hurt.
- The `section.lead` legacy rules were removed but child classes (`.lead-tier`, `.lead-headline`, `.lead-dek`, `.lead-meta`) are still used inside `.hero-lead` — they're not "lead-prefixed orphans," they're just sitting in their old block. Fine functionally; could be renamed for clarity later.
- The `EDITORIAL_BYLINE_SLUG` constant in `brand.mjs` says `'filings-editorial'` with a comment noting the URL is intentionally unchanged. Don't "fix" this without setting up a redirect.

### Accessibility
- Theme toggle has `aria-label`. Search link has `aria-label`. Most interactive elements are anchored to real semantic tags.
- Skip-to-content link is **not present**. Worth adding for keyboard users.
- Colour contrast: brick red on white passes WCAG AA for large text but not for body. We don't use accent for body text — accent is reserved for tier labels and ornaments. OK.

---

## Potential optimizations / future ideas

These were noted during the session but deliberately skipped:

1. **Per-article OG image with the dek** — current OG shows tier + sector + headline. Could overflow into a 1-2 line italic dek below the rule. Risk: text wraps badly at small horizontal widths.
2. **Subset the woff2 fonts further.** Right now Vietnamese / latin-ext subsets ship — they load on demand via unicode-range so they're fine, but stripping unused subsets could shave ~150 KB from `/public/fonts/`.
3. **Replace the entire `section.lead` legacy block** in `global.css` — leftover from the redesign, some rules apply only to old templates.
4. **`Story so far` timeline in gutter** could be made more prominent. Currently a small list — could be styled with hairlines and dates.
5. **Lazy-load market sparklines** on `/markets/` (see Performance above).
6. **Daily build automation.** With ~2-minute builds and a daily cadence, Cloudflare Pages / Vercel cron rebuilds work fine. The pipeline upstream needs to write the SQLite DB before Astro builds against it.
7. **OG image variants for index pages** (Briefings, Concalls, Markets) — currently they all use `/og/brand.png`. Could template a "section card" per index.
8. **Self-host the Inter and JetBrains Mono subsets too** — currently they're self-hosted but the unicode-range coverage may not include all currency symbols we use (₹). Verify and add if needed.

---

## Things you'll need from the previous conversation context (Claude memory)

These live in `~/.claude/projects/.../memory/`:

- **`user_founder.md`** — solo operator, FT Lex voice, no AI slop
- **`project_filings.md`** — what the publication is (note: still references "Filings" brand — rebrand to Tipsheet has happened; memory may need updating)
- **`feedback_editorial_voice.md`** — voice non-negotiables (Alert/Story/Update tier names — note: now Alert/Lead/Brief; memory needs updating)
- **`reference_data_sources.md`** — Tijori feed, Kite Screener, etc.
- **`project_costs_models.md`** — DeepSeek V4 Flash, ~$25/yr budget
- **`reference_seo_strategy.md`** — SEO playbook

**Update these memory files** to reflect the rebrand (Stories → Tipsheet, tier rename) so future sessions don't drift back to old names.

---

## Conventions to keep

- Brand text always flows from `lib/brand.mjs` — never hardcode the brand name in new templates.
- Tier names always flow from `tierFor()` in `lib/queries.mjs` — never hardcode.
- Use design tokens in `global.css`, never hex codes (the only exceptions are in `og.mjs` and `icon.mjs`, where colours are baked into PNG output and can't be theme-aware).
- Mono caps reserved for tier labels, tickers, dates, kicker meta. Everything else: serif (italic for editorial flavour).
- Numeric financial values use `var(--data)` (Inter) with `font-feature-settings: "tnum" 1, "lnum" 1, "cv11" 1`.
- Hover state on headlines: shift to `var(--accent)`.
- Accent rule (24px wide × 1px) precedes every major section heading.
