# Tipsheet — Makefile
#
# Canonical reference for all pipeline + site operations.
# Usage:
#   make poll              — fetch Tijori feed
#   make enrich N=100      — enrich up to 100 filings
#   make pipeline          — full pipeline cycle
#   make build             — build Astro site
#   make check             — run sanity checks
#
# Requires: Node ≥22, .env file in project root.

.PHONY: poll enrich both fundamentals slugs radar concalls-poll concalls-enrich \
        concalls macro briefing-open briefing-close telegram stats widgets widgets-cache-only \
        pipeline dev build preview check install help

ENV  = --env-file=../.env
PIPE = cd pipeline && node $(ENV) run.mjs

# ─── Pipeline ────────────────────────────────────────────────────────

poll:
	$(PIPE) poll

enrich:
	$(PIPE) enrich $(or $(N),50)

both:
	$(PIPE) both $(or $(N),50)

fundamentals:
	$(PIPE) fetch-fundamentals

slugs:
	$(PIPE) resolve-tijori-slugs $(or $(N),100)

radar:
	$(PIPE) generate-radar $(or $(N),80)

concalls-poll:
	$(PIPE) poll-concalls $(or $(N),100)

concalls-enrich:
	$(PIPE) enrich-concalls $(or $(N),50)

concalls:
	$(PIPE) concalls $(or $(N),100)

macro:
	$(PIPE) poll-macro-calendar

# Index moves + per-stock weekly history (Python — yfinance). Runs before each
# briefing so the market strip and event sparklines are fresh.
market-yf:
	cd pipeline && python3 market_yf.py --hours $(or $(H),36)

briefing-open: market-yf
	$(PIPE) briefing-open

briefing-close: market-yf
	$(PIPE) briefing-close

telegram:
	cd pipeline && node $(ENV) notify_telegram.mjs

stats:
	$(PIPE) stats

loop:
	cd pipeline && node $(ENV) loop.mjs

# Tijori SDK widget refresh (Python — requires tijori_scraper virtualenv)
widgets:
	cd pipeline && python3 tijori_widgets.py --limit $(or $(N),80)

widgets-cache-only:
	cd pipeline && python3 tijori_widgets.py --cache-only --limit $(or $(N),80)

# ─── Full pipeline cycle (what GitHub Actions cron runs) ─────────────

pipeline: poll enrich fundamentals slugs concalls briefing-close radar
	@echo ""
	@echo "✓ Pipeline cycle complete"

# ─── Site ────────────────────────────────────────────────────────────

dev:
	cd site && npm run dev

build:
	cd site && npm run build

preview:
	cd site && npm run preview

# ─── Sanity checks ──────────────────────────────────────────────────

check:
	@echo "── DB sanity ──"
	@$(PIPE) stats 2>/dev/null || echo "  (could not run stats — check Node version)"
	@echo ""
	@echo "── Stale tier labels (Story/Update used as tier name) ──"
	@grep -rn '"Story"\|"Update"' site/src/pages/ --include="*.astro" \
		| grep -vi "story so far" \
		| grep -vi "ARTICLE_TYPE" \
		| grep -vi "editorial" \
		| grep -vi "comment" \
		| grep -vi "//.*Story" \
		|| echo "  (clean)"
	@echo ""
	@echo "── Yahoo references ──"
	@grep -rni "yahoo\|yfinance" site/src/ pipeline/*.mjs || echo "  (clean)"
	@echo ""
	@echo "── Google Fonts CDN ──"
	@grep -rni "fonts.googleapis\|fonts.gstatic" site/src/ || echo "  (clean)"
	@echo ""
	@echo "── tipsheet.markets domain ──"
	@grep -rn "tipsheet.markets" site/astro.config.mjs 2>/dev/null || echo "  (not found — check if domain is set)"

# ─── Install ─────────────────────────────────────────────────────────

install:
	cd pipeline && npm install
	cd site && npm install

# ─── Help ─────────────────────────────────────────────────────────────

help:
	@echo "Pipeline:"
	@echo "  make poll              Fetch Tijori feed"
	@echo "  make enrich [N=50]    Enrich up to N filings"
	@echo "  make both [N=50]      Poll + enrich"
	@echo "  make fundamentals     Fetch Kite Screener fundamentals"
	@echo "  make slugs [N=100]    Resolve Tijori company slugs"
	@echo "  make radar [N=80]     Generate/refresh Radar items"
	@echo "  make concalls [N=100] Poll + enrich concalls"
	@echo "  make macro            Poll IDH macro calendar"
	@echo "  make market-yf [H=36] Fetch index moves + stock weekly history (yfinance)"
	@echo "  make briefing-open    Generate The Open briefing"
	@echo "  make briefing-close   Generate The Close briefing"
	@echo "  make telegram         Send Telegram briefing/article digest"
	@echo "  make stats            Show DB statistics"
	@echo "  make widgets [N=80]   Refresh Tijori SDK widgets (Python)"
	@echo "  make pipeline         Full pipeline cycle"
	@echo "  make loop             Run continuous local scheduler"
	@echo ""
	@echo "Site:"
	@echo "  make dev              Start Astro dev server"
	@echo "  make build            Build static site"
	@echo "  make preview          Serve built site"
	@echo ""
	@echo "Ops:"
	@echo "  make check            Run sanity checks"
	@echo "  make install          Install all dependencies"
