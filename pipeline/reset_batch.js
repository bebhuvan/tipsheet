import Database from 'better-sqlite3';
const db = new Database('../data/filings.db');

// Get the latest 50 enriched records that are missing faqs
const rows = db.prepare(`
  SELECT record_id, headline 
  FROM filings_enriched 
  WHERE validation_ok = 1 AND faqs IS NULL 
  ORDER BY enriched_at DESC 
  LIMIT 50
`).all();

console.log(`Found ${rows.length} recent articles missing faqs.`);

const stmt = db.prepare('UPDATE filings_enriched SET validation_ok = 0 WHERE record_id = ?');
const tx = db.transaction((items) => {
  for (const r of items) stmt.run(r.record_id);
});
tx(rows);

console.log('Reset validation_ok to 0 for these records so they will be picked up by the enricher.');
