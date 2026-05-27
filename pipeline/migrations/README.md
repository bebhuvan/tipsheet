# Pipeline Migrations

`pipeline/schema.sql` remains the complete bootstrap schema. New production
schema changes should also be added here as timestamped SQL files so D1 can be
migrated without relying on ad hoc startup migrations.

Current bootstrap additions from the architecture pass:

- `filings_enriched.slug`
- `source_health`
