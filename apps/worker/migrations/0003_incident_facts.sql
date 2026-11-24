-- Structured incident facts for official-report candidates (2026-11-24).
-- JSON validated by @gof/core incidentFactsSchema on import: roles (never names), normalized actions,
-- legal stage, location/date with their basis, claims that point at passage/sentence/digest in the
-- source (no source text is stored), safety flags, quality scores and the draft's validation result.
-- Internal only: never served by the public API. NULL for every other provider (backward compatible).
ALTER TABLE incidents ADD COLUMN facts TEXT;
