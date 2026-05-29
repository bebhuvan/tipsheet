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

const DEFAULTS = { STALE_MINUTES: 75, WORKFLOW_FILE: 'pipeline.yml', GITHUB_REF: 'main', SOURCE_STALE_HOURS: 30 };
const COOLDOWN_MINUTES = 30;
const SOURCE_ALERT_COOLDOWN_MIN = 360; // 6h — don't re-nag about the same broken source

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

async function sendTelegram(env, text) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return false;
  const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text, disable_web_page_preview: true }),
  });
  return r.ok;
}

// Per-source alerting: a source is "bad" if it explicitly recorded failure or
// its last success is older than the (generous) per-source staleness window.
// Now that every stream writes source_health, this surfaces silent breakages
// like a missing TIJORI_COOKIE that the overall-freshness check would miss.
// Per-source KV cooldown prevents re-nagging; no-op if KV / Telegram absent.
async function alertStaleSources(env, health, now) {
  const sources = Array.isArray(health.sources) ? health.sources : [];
  if (!sources.length) return [];
  const staleMs = Number(env.SOURCE_STALE_HOURS || DEFAULTS.SOURCE_STALE_HOURS) * 60 * 60 * 1000;
  const bad = sources.filter((s) => {
    if (s.status === 'failure') return true;
    const last = s.last_success_at;
    return last != null && minutesSince(last, now) * 60000 > staleMs;
  });
  const alerted = [];
  for (const s of bad) {
    const key = `alert:${s.source}`;
    if (env.WATCHDOG) {
      const last = await env.WATCHDOG.get(key);
      if (last && minutesSince(Number(last), now) < SOURCE_ALERT_COOLDOWN_MIN) continue;
    }
    const ageH = s.last_success_at ? Math.round(minutesSince(s.last_success_at, now) / 60) : '∞';
    const ok = await sendTelegram(
      env,
      `⚠️ Tipsheet source degraded: ${s.source}\nstatus=${s.status || '?'} last_success=${ageH}h ago` +
      (s.error ? `\nerror: ${String(s.error).slice(0, 200)}` : ''),
    );
    if (ok && env.WATCHDOG) await env.WATCHDOG.put(key, String(now.getTime()));
    if (ok) alerted.push(s.source);
  }
  return alerted;
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

  // Per-source alerts run every tick — a single source can be broken while the
  // site overall looks fresh.
  const sourceAlerts = await alertStaleSources(env, health, now);

  const stale = stalenessMinutes(health, now);
  const threshold = Number(env.STALE_MINUTES || DEFAULTS.STALE_MINUTES);
  if (stale <= threshold) return { action: 'ok', staleMinutes: Math.round(stale), threshold, sourceAlerts };

  if (await onCooldown(env, now)) {
    return { action: 'cooldown', staleMinutes: Math.round(stale), threshold, sourceAlerts };
  }

  await dispatchWorkflow(env);
  if (env.WATCHDOG) await env.WATCHDOG.put('last_dispatch', String(now.getTime()));
  return { action: 'dispatched', staleMinutes: Math.round(stale), threshold, workflow: env.WORKFLOW_FILE || DEFAULTS.WORKFLOW_FILE, sourceAlerts };
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
