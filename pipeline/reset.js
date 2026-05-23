import Database from 'better-sqlite3';
const db = new Database('../data/filings.db');
db.prepare("UPDATE filings_enriched SET validation_ok = 0 LIMIT 1").run();
console.log(db.prepare("SELECT record_id FROM filings_enriched WHERE validation_ok = 0").get());
