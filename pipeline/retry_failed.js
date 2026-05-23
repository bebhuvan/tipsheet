import Database from 'better-sqlite3';
const db = new Database('../data/filings.db');

// Reset recently failed articles
const stmt = db.prepare("DELETE FROM filings_enriched WHERE validation_ok = 0");
const info = stmt.run();

console.log(`Reset ${info.changes} failed records so they will be picked up by the enricher.`);
