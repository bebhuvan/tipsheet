// Single source of truth for the publication's brand identity.
//
// Rename in 30 seconds:
//   1. Change BRAND_NAME below. Optionally adjust TAGLINE, POSSESSIVE, BYLINE.
//   2. Rebuild — every page title, schema, RSS/JSON feed, sitemap, masthead, footer,
//      and OG image picks up the new name automatically.
//
// What this does NOT cover (rename by hand if you change the brand):
//   • Body prose in /about/, /methodology/, /editorial-standards/, /terms/,
//     /ownership/, /contact/, /privacy/, /corrections/, /authors/* — these are
//     editorial pages with prose like "[Brand] is an editorial publication" that
//     can't be safely auto-templated without risking grammar issues.
//   • The /authors/filings-editorial/ URL slug. If you change the editorial-byline
//     pattern, rename the file too and add a redirect.
//   • llms.txt and robots.txt in /public/ — edit by hand.

export const BRAND_NAME           = 'Tipsheet';
export const BRAND_NAME_POSSESSIVE = "Tipsheet's";
export const BRAND_TAGLINE        = 'What matters at India’s listed companies';

// Public Telegram channel (shown in the masthead). Set to the real handle.
export const BRAND_TELEGRAM_URL   = 'https://t.me/tipsheetalerts';

// Verified external identities for the publication. Wired into the sitewide
// NewsMediaOrganization `sameAs` — the single highest-leverage entity-authority
// signal for Google's Knowledge Graph and for LLM attribution. ONLY list URLs
// that resolve to a real, publicly owned profile.
//
// TODO (highest priority, mostly off-code work):
//   • Create a Wikidata item for Tipsheet and add it here, e.g.
//     'https://www.wikidata.org/wiki/Q________'
//   • Add the LinkedIn company page and X/Twitter profile once live, e.g.
//     'https://www.linkedin.com/company/tipsheet-markets/',
//     'https://x.com/tipsheetmkts',
export const BRAND_SAMEAS = [
  BRAND_TELEGRAM_URL,
].filter(Boolean);

// What a single article is called. Editorial term used in copy.
// Kept as 'Story'/'Stories' to avoid the operator-tips connotation if we'd used "tip".
export const ARTICLE_TYPE         = 'Story';
export const ARTICLE_TYPE_PLURAL  = 'Stories';

// The byline shown on every article when no individual reporter is named.
export const EDITORIAL_BYLINE     = 'Tipsheet Editorial';
export const EDITORIAL_BYLINE_SLUG = 'filings-editorial';  // /authors/filings-editorial/  (URL unchanged)

// Long description for schema + sitewide meta. Edit to taste.
export const BRAND_DESCRIPTION =
  'What matters at India’s listed companies. Every ' + ARTICLE_TYPE + ' is grounded in a primary source — an exchange disclosure, regulator notice, or earnings call. No clickbait, no ads, no paywall.';

// Short footer about-text used in SiteFooter.
export const BRAND_FOOTER_ABOUT =
  BRAND_NAME + ' is a sharp, independent read on India’s listed companies — every consequential disclosure to the Bombay and National Stock Exchanges. We publish what matters; we don\'t write what doesn\'t. No clickbait. No filler. No paid placements.';

// Founding date (used in Organization schema). YYYY-MM.
export const BRAND_FOUNDING_DATE = '2026-05';
