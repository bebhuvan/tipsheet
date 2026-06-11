# Authority playbook — getting Google to trust tipsheet.markets

Written 2026-06-11, after the Search Console review. Context: no manual action,
no technical defects; 964 pages sit in "Crawled – currently not indexed", which
is Google's quality/authority verdict on a 3-week-old domain publishing at
newsroom volume. On-page work is done (snapshot prerender, curated news
sitemap, per-company feeds — shipped in this branch). What remains is entity
authority, and every item below needs your accounts, so it's a checklist for
you rather than code.

## 1. Google Publisher Center (highest value, ~30 min)

The single most direct trust lever for a news site. It tells Google "this is a
publication, not a content farm" and is the gateway to the Google News tab,
Discover prominence, and the publication knowledge panel.

1. Go to https://publishercenter.google.com/ with the Google account that owns
   the Search Console property (r.bhuvanesh2007@gmail.com).
2. Add publication → name "Tipsheet", primary URL `https://tipsheet.markets`.
   Ownership auto-verifies through Search Console.
3. Fill everything in publication settings — every blank field is a missed
   trust signal:
   - Location: India. Language: English.
   - Contacts: a real editorial contact email.
   - Logo: the square 1000×1000 (`/logo.png`) and a wordmark.
4. Under "Google News" → source settings, add content labels (no paywall,
   original reporting) and section feeds. Good section feeds to register:
   - `https://tipsheet.markets/feed.xml` (everything)
   - `https://tipsheet.markets/sitemap-news.xml` is discovered automatically;
     don't resubmit it here.
5. Publish. Review typically takes days to a few weeks. Inclusion in the News
   *tab* is algorithmic now, but a complete Publisher Center profile feeds the
   trust models either way.

## 2. Wikidata entity (~30 min, do once)

Google's Knowledge Graph treats Wikidata as an authoritative entity source.
This is the cheapest "we exist as an organization" signal available.

1. Create an account at https://www.wikidata.org (any account works; edits
   from brand-new accounts are fine on Wikidata, unlike Wikipedia).
2. Create a new item: label "Tipsheet", description "Indian financial news
   publication covering stock exchange filings".
3. Statements to add:
   - `instance of (P31)` → `online newspaper (Q1153191)` (or
     `news website (Q17232649)`)
   - `official website (P856)` → `https://tipsheet.markets`
   - `language of work (P407)` → English
   - `country (P17)` → India
   - `inception (P571)` → 2026
4. Note the Q-id it assigns (e.g. Q131234567).
5. Then add that Q-id to `BRAND_SAMEAS` in `site/src/lib/brand.mjs` as
   `https://www.wikidata.org/wiki/Q…` — the Organization schema sitewide
   already emits `sameAs`, so this closes the loop. (Code change — I can do
   this the moment you have the Q-id.)

## 3. Distribution that earns links (ongoing)

"Crawled – currently not indexed" resolves with external signals. Realistic,
non-spammy channels for a filings publication:

- **Pulse by Zerodha** (https://pulse.zerodha.com) aggregates Indian finance
  RSS. Email them to add `https://tipsheet.markets/feed.xml`. Given the
  Rainmatter connection this should be an easy yes, and it's a real referring
  domain Google sees.
- **Per-company feeds for journalists**: each company page now advertises
  `/company/<symbol>/feed.xml`. When you talk to beat reporters, the pitch is
  "subscribe to the ticker, not the site".
- **X/LinkedIn presence posting the Alerts**: brand-name searches ("tipsheet
  markets") are themselves a trust signal Google measures. A dozen genuine
  followers who search for you by name beat a hundred backlinks from
  directories.
- **The Open/Close as an email digest** (Substack or Buttondown with a custom
  domain) — newsletters get forwarded, quoted, and linked.

## 4. What NOT to do

- Don't buy links, submit to directories, or do "guest post outreach" — on a
  3-week-old domain these pattern-match to spam and can convert a soft quality
  filter into a real one.
- Don't repeatedly press "Validate fix" in Search Console — validation is
  already running (started 6/7); it re-crawls on its own schedule.
- Don't churn URLs or restructure the site to "fix" indexing. URL stability is
  already a stated hard constraint; keep it.
- Don't add AI-disclosure badges per article (Discover demotes them;
  methodology-page disclosure is enough — see reference_seo_strategy).

## 5. How to measure (weekly, 5 min)

In Search Console, watch three numbers weekly — write them down:

1. Pages → Indexed count (currently ~1.17K)
2. Pages → "Crawled – currently not indexed" (currently 964)
3. Performance → impressions/day (currently near zero after the May 28 drop)

Expect nothing for 4–6 weeks; new-domain trust moves on a quarter timescale.
The decision gate we agreed: if by ~mid-July the not-indexed bucket hasn't
shrunk and impressions haven't recovered, revisit index pruning (noindex on
score ≤6 Updates) — the strongest remaining lever, deliberately deferred.
