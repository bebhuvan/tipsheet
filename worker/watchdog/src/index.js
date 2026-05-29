// Tipsheet Freshness Watchdog — Cloudflare Worker (Cron Trigger)
//
// GitHub's scheduled workflows are best-effort: runs get delayed or silently
// dropped under load, and a broken deploy means fresh data never reaches the
// site. This Worker is the safety net. On a cron tick it reads the site's
// /api/health.json (which reflects the last successful build/deploy) and, if
// the site is stale during the active window, re-dispatches the Fast News
// workflow via the GitHub API. Fast News' success then chains a deploy
// (publish-site.yml), so a single dispatch heals both ingest and deploy gaps.
//
// Secrets / vars (wrangler.toml [vars] + `wrangler secret put`):
//   GITHUB_TOKEN        — fine-grained PAT, repo Actions: read+write   (secret)
//   GITHUB_REPOSITORY   — "owner/repo"                                  (var)
//   HEALTH_URL          — https://tipsheet.markets/api/health.json      (var)
//   WORKFLOW_FILE       — workflow to dispatch, default "pipeline.yml"  (var)
//   STALE_MINUTES       — staleness threshold, default 75               (var)
//   GITHUB_REF          — branch to dispatch on, default "main"         (var)
// Optional KV binding `WATCHDOG` enforces a dispatch cooldown so we never spam.

const DEFAULTS = { STALE_MINUTES: 75, WORKFLOW_FILE: 'pipeline.yml', GITHUB_REF: 'main' };
const COOLDOWN_MINUTES = 30;

// Active window in IST when we expect fresh data. Mon–Fri ~07:00–23:00 IST.
// (IST = UTC+5:30.) Outside this window staleness is expected; don't dispatch.
function inActiveWindow(now) {
  const istMs = now.getTime() + (5 * 60 + 30) * 60 * 1000;
  const ist = new Date(istMs);
  const day = ist.getUTCDay();           // 0 Sun … 6 Sat
  const hour = ist.getUTCHours();
  if (day === 0 || day === 6) return hour >= 8 && hour <= 21; // lighter weekend window
  return hour >= 7 && hour <= 22;
}

function minutesSince(value, now) {
  if (!value) return Infinity;
  // Accept ISO strings and epoch ms/seconds.
  let t;
  if (typeof value === 'number') t = value < 1e12 ? value * 1000 : value;
  else t = Date.parse(value);
  if (!Number.isFinite(t)) return Infinity;
  return (now.getTime() - t) / 60000;
}

async function readHealth(url) {
  const r = await fetch(url, { cf: { cacheTtl: 0 }, headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error(`health ${r.status}`);
  return r.json();
}

// Freshest signal the site exposes: last enrich, last filing, or build time.
function stalenessMinutes(health, now) {
  return Math.min(
    minutesSince(health.latest_enriched_at, now),
    minutesSince(health.latest_filing_created_on, now),
    minutesSince(health.generated_at, now),
  );
}

async function dispatchWorkflow(env) {
  const repo = env.GITHUB_REPOSITORY;
  const file = env.WORKFLOW_FILE || DEFAULTS.WORKFLOW_FILE;
  const ref = env.GITHUB_REF || DEFAULTS.GITHUB_REF;
  const resp = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${file}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'tipsheet-watchdog',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref }),
  });
  if (!resp.ok) throw new Error(`dispatch ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
}

async function onCooldown(env, now) {
  if (!env.WATCHDOG) return false;
  const last = await env.WATCHDOG.get('last_dispatch');
  if (!last) return false;
  return minutesSince(Number(last), now) < COOLDOWN_MINUTES;
}

async function check(env, now) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY || !env.HEALTH_URL) {
    return { action: 'misconfigured', detail: 'missing GITHUB_TOKEN / GITHUB_REPOSITORY / HEALTH_URL' };
  }
  if (!inActiveWindow(now)) return { action: 'idle', reason: 'outside active window' };

  const health = await readHealth(env.HEALTH_URL);
  const stale = stalenessMinutes(health, now);
  const threshold = Number(env.STALE_MINUTES || DEFAULTS.STALE_MINUTES);
  if (stale <= threshold) return { action: 'ok', staleMinutes: Math.round(stale), threshold };

  if (await onCooldown(env, now)) {
    return { action: 'cooldown', staleMinutes: Math.round(stale), threshold };
  }

  await dispatchWorkflow(env);
  if (env.WATCHDOG) await env.WATCHDOG.put('last_dispatch', String(now.getTime()));
  return { action: 'dispatched', staleMinutes: Math.round(stale), threshold, workflow: env.WORKFLOW_FILE || DEFAULTS.WORKFLOW_FILE };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      check(env, new Date())
        .then((r) => console.log('[watchdog]', JSON.stringify(r)))
        .catch((e) => console.error('[watchdog] error:', e.message)),
    );
  },

  // GET for manual inspection / debugging (no dispatch side effect unless stale).
  async fetch(_request, env) {
    try {
      const result = await check(env, new Date());
      return Response.json(result);
    } catch (e) {
      return Response.json({ action: 'error', error: e.message }, { status: 500 });
    }
  },
};
