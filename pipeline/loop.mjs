// Continuous scheduler for local dev. In production, replaced by Cloudflare Cron Triggers.
//
// Behaviour:
//   • Every POLL_INTERVAL_SEC: poll feed → enrich up to ENRICH_BATCH_SIZE new filings.
//   • Idempotent: running twice causes no duplicate work (dedup is at the DB layer).
//   • Logs each cycle's outcome; sleeps; repeats.
//   • Graceful SIGINT/SIGTERM shutdown.
//
// Run with:  node --env-file=../.env loop.mjs

import { poll, enrichBatch, pollConcalls, enrichConcallsBatch, resolveTijoriSlugs, generateRadar } from './run.mjs';

const POLL_INTERVAL_SEC          = Number(process.env.POLL_INTERVAL_SEC || 120);
const ENRICH_BATCH_SIZE          = Number(process.env.ENRICH_BATCH_SIZE || 50);
const CONCALLS_EVERY_N_CYCLES    = Number(process.env.CONCALLS_EVERY_N_CYCLES || 4);
const CONCALLS_POLL_BUDGET       = Number(process.env.CONCALLS_POLL_BUDGET || 50);
const CONCALLS_ENRICH_BATCH_SIZE = Number(process.env.CONCALLS_ENRICH_BATCH_SIZE || 20);

let running = true;
process.on('SIGINT',  () => { console.log('\n[loop] SIGINT received — finishing current cycle then exiting'); running = false; });
process.on('SIGTERM', () => { console.log('\n[loop] SIGTERM received — finishing current cycle then exiting'); running = false; });

async function cycle(n) {
  const t0 = Date.now();
  console.log(`\n[loop] cycle #${n} starting (${new Date().toISOString()})`);
  try {
    await poll();
    await enrichBatch(ENRICH_BATCH_SIZE);
    await resolveTijoriSlugs(50);
    await generateRadar();
    // Concalls update slower than filings; poll less often to respect Tijori's API.
    if (n % CONCALLS_EVERY_N_CYCLES === 0) {
      try {
        await pollConcalls(CONCALLS_POLL_BUDGET);
        await enrichConcallsBatch(CONCALLS_ENRICH_BATCH_SIZE);
        await generateRadar();
      } catch (e) {
        console.error('[loop] concalls cycle error (non-fatal):', e.message);
      }
    }
  } catch (e) {
    console.error('[loop] cycle error:', e.message);
  }
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`[loop] cycle #${n} done in ${elapsed}s`);
}

async function sleep(seconds) {
  for (let i = 0; i < seconds && running; i++) {
    await new Promise(r => setTimeout(r, 1000));
  }
}

let cycleN = 0;
console.log(`[loop] starting — poll every ${POLL_INTERVAL_SEC}s, enrich up to ${ENRICH_BATCH_SIZE} per cycle`);
console.log(`[loop] concalls cadence — every ${CONCALLS_EVERY_N_CYCLES} cycles (poll up to ${CONCALLS_POLL_BUDGET}, enrich up to ${CONCALLS_ENRICH_BATCH_SIZE})`);
console.log('[loop] press Ctrl+C to stop after the current cycle');
while (running) {
  cycleN++;
  await cycle(cycleN);
  if (!running) break;
  console.log(`[loop] sleeping ${POLL_INTERVAL_SEC}s …`);
  await sleep(POLL_INTERVAL_SEC);
}
console.log('[loop] stopped cleanly');
