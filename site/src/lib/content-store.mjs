// Async ContentStore — the swap boundary between build-time SQLite and
// runtime Cloudflare D1 (Phase 2 of the reliability refactor).
//
// WHY: today every Astro page imports `queries.mjs` directly and calls
// synchronous better-sqlite3 functions. D1 is async and returns different
// shapes, so a future cutover would have to touch every call site at once.
// This module is the single async seam: pages read `await store.x()` instead
// of `Q.x()`, so the D1 cutover (Phase 3) and the hybrid-render flip (Phase 4)
// change ONE factory, not 40 pages.
//
//   createSqliteStore() — async facade over the proven sync queries in
//                         queries.mjs (build time + local dev). No logic is
//                         duplicated; every export is wrapped to return a
//                         Promise so call sites can `await` uniformly.
//   createD1Store(db)   — same interface, backed by env.DB. Implemented during
//                         the Phase 3 cutover against a live D1 instance.
//   getStore(env)       — D1 when env.DB is bound (runtime SSR), else SQLite.
//
// Migration is incremental and safe: a page can adopt the store the moment its
// data needs become async; until then queries.mjs keeps working untouched.

import * as Q from './queries.mjs';

// Wrap every exported function as async; pass constants (e.g. MARKET_CAP_TIERS)
// through untouched. An async wrapper over a sync function is harmless — it
// just lets SQLite and D1 share one `await`-based contract.
function asyncFacade(mod) {
  const store = {};
  for (const key of Object.keys(mod)) {
    const value = mod[key];
    store[key] = typeof value === 'function'
      ? (...args) => Promise.resolve(value(...args))
      : value;
  }
  return store;
}

let _sqliteStore;
export function createSqliteStore() {
  return (_sqliteStore ??= asyncFacade(Q));
}

export function createD1Store(/* db */) {
  // Phase 3: implement the SSR read surface against db.prepare(sql).bind(...).all().
  // Reuse the SQL + row-shaping from queries.mjs (extract the shared SQL strings
  // during the cutover, when a live D1 instance exists to validate against).
  // Tier-1 pages stay prerendered via the SQLite store at build time, so only
  // the Tier-2 long-tail read paths need a D1 implementation first.
  return new Proxy({}, {
    get(_t, prop) {
      return () => {
        throw new Error(
          `ContentStore: D1 backend not yet implemented for "${String(prop)}". ` +
          'The SQLite store is active for the build; the D1 backend lands in the Phase 3 cutover.',
        );
      };
    },
  });
}

// env is the Astro/Workers runtime env. At static build time there is no
// env.DB, so this returns the SQLite store. Under SSR on Workers (Phase 4),
// env.DB is the bound D1 database.
export function getStore(env) {
  if (env && env.DB) return createD1Store(env.DB);
  return createSqliteStore();
}
