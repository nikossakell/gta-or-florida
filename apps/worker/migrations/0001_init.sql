-- 0001 — initial D1 schema for GTA or Florida?
-- Ported from the legacy better-sqlite3 schema (apps/api, removed) with these changes:
--  * rights live on `sources` (owner-reviewed source policy), not on each reference
--  * source_references replace source_records + incident_sources (one incident, many outlets)
--  * questions carry the automated gate decision (shadow trace) separately from the human state
--  * daily_rounds/daily_round_items replace daily_challenges (positions 1-5, UNIQUE question)
--  * idempotency_keys for safe retries of authenticated imports
-- D1 enforces foreign keys by default.

CREATE TABLE sources (
  id TEXT PRIMARY KEY,                       -- e.g. publisher:tampabay.com, grandtheftwiki
  type TEXT NOT NULL CHECK (type IN ('publisher','gta_wiki','player_platform')),
  name TEXT NOT NULL,
  canonical_host TEXT NOT NULL,
  license_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (license_status IN ('unreviewed','approved','blocked')),
  can_display_original_title INTEGER NOT NULL DEFAULT 0 CHECK (can_display_original_title IN (0,1)),
  can_use_editorial_summary INTEGER NOT NULL DEFAULT 0 CHECK (can_use_editorial_summary IN (0,1)),
  auto_publish_allowed INTEGER NOT NULL DEFAULT 0 CHECK (auto_publish_allowed IN (0,1)),
  policy_version TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  terms_url TEXT,
  notes TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (license_status = 'approved' OR (can_display_original_title = 0 AND can_use_editorial_summary = 0 AND auto_publish_allowed = 0))
);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  incident_key TEXT NOT NULL UNIQUE,         -- gta:grandtheftwiki:<pageid>#<anchor> | fl:<fingerprint>
  kind TEXT NOT NULL CHECK (kind IN ('FLORIDA_NEWS','GTA_CANON','GTA_PLAYER_EVENT')),
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('wildlife','crime','vehicles','weird','other')),
  game TEXT,                                 -- verified GTA title (set on approval)
  game_detected TEXT,                        -- deterministic hint from the wiki page
  occurred_at TEXT,
  florida_location TEXT,                     -- supporting evidence text (verbatim from source)
  florida_signal TEXT CHECK (florida_signal IN ('title','domain','none')),
  location_verified INTEGER NOT NULL DEFAULT 0 CHECK (location_verified IN (0,1)),
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','verified','rejected')),
  sensitivity TEXT NOT NULL DEFAULT 'unknown' CHECK (sensitivity IN ('unknown','ok','sensitive')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','rejected')),
  merged_into TEXT REFERENCES incidents(id),
  possible_duplicate_of TEXT REFERENCES incidents(id),
  similarity REAL,
  notes TEXT,                                -- internal only, never public
  is_fixture INTEGER NOT NULL DEFAULT 0 CHECK (is_fixture IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT
);
CREATE INDEX idx_incidents_kind_status ON incidents(kind, status, verification_status);

CREATE TABLE source_references (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  source_id TEXT NOT NULL REFERENCES sources(id),
  provider TEXT NOT NULL,                    -- gdelt | rss | grandtheftwiki | legacy | fixture
  provider_key TEXT,                         -- wiki page id + section anchor, feed guid, ...
  original_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL UNIQUE,
  original_title TEXT NOT NULL,              -- internal; public only if the source policy allows
  publisher TEXT,
  published_at TEXT,
  provider_seen_at TEXT,
  wiki_page_id INTEGER,
  wiki_section TEXT,
  content_digest TEXT NOT NULL,
  link_status TEXT NOT NULL DEFAULT 'unchecked' CHECK (link_status IN ('unchecked','ok','manual_ok','broken')),
  http_status INTEGER,
  final_url TEXT,
  checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_refs_provider_key ON source_references(provider, provider_key) WHERE provider_key IS NOT NULL;
CREATE INDEX idx_refs_incident ON source_references(incident_id);
CREATE INDEX idx_refs_digest ON source_references(content_digest);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL UNIQUE REFERENCES incidents(id),
  primary_reference_id TEXT NOT NULL REFERENCES source_references(id),
  answer_kind TEXT NOT NULL CHECK (answer_kind IN ('FLORIDA','GTA')),
  play_title TEXT NOT NULL,
  play_title_reviewed INTEGER NOT NULL DEFAULT 0 CHECK (play_title_reviewed IN (0,1)),
  play_title_fingerprint TEXT,               -- core titleFingerprint(play_title); unique among approved/retired
  explanation TEXT NOT NULL DEFAULT '',
  difficulty INTEGER NOT NULL DEFAULT 2 CHECK (difficulty BETWEEN 1 AND 3),
  quality_state TEXT NOT NULL DEFAULT 'candidate' CHECK (quality_state IN ('candidate','approved','rejected','retired')),
  gate_decision TEXT CHECK (gate_decision IN ('auto_approve','review','reject')),
  gate_reasons TEXT,                         -- JSON array
  confidence_metadata TEXT,                  -- JSON: model ids, prompt version, AI trace (never a calibrated probability)
  eligible_for_auto_publish INTEGER NOT NULL DEFAULT 0 CHECK (eligible_for_auto_publish IN (0,1)),
  approved_by TEXT,
  approved_at TEXT,
  approval_actor_type TEXT CHECK (approval_actor_type IN ('human','policy')),
  rejected_reason TEXT,
  retired_reason TEXT,
  is_fixture INTEGER NOT NULL DEFAULT 0 CHECK (is_fixture IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT,
  CHECK (quality_state <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND length(explanation) >= 20))
);
CREATE INDEX idx_questions_state ON questions(quality_state, answer_kind);
CREATE INDEX idx_questions_gate ON questions(gate_decision, quality_state);
CREATE UNIQUE INDEX idx_questions_title_unique ON questions(answer_kind, play_title_fingerprint)
  WHERE quality_state IN ('approved','retired') AND play_title_fingerprint IS NOT NULL;

CREATE TABLE daily_rounds (
  day TEXT PRIMARY KEY CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  number INTEGER NOT NULL UNIQUE CHECK (number >= 1),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','published','withdrawn')),
  florida_count INTEGER NOT NULL CHECK (florida_count IN (2,3)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  published_at TEXT,
  withdrawn_reason TEXT,                     -- internal audit reason
  public_message TEXT,                       -- shown to players when withdrawn
  content_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_rounds_status ON daily_rounds(status, day);

CREATE TABLE daily_round_items (
  day TEXT NOT NULL REFERENCES daily_rounds(day),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 5),
  question_id TEXT NOT NULL UNIQUE REFERENCES questions(id),  -- a question is never reused
  PRIMARY KEY (day, position)
);

CREATE TABLE ingestion_runs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','ok','partial','failed')),
  fetched_count INTEGER NOT NULL DEFAULT 0,
  new_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  errors TEXT,                               -- JSON array of short messages
  model_id TEXT,                             -- comma-separated model ids used
  ai_requests INTEGER NOT NULL DEFAULT 0,
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  neurons_estimate REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_runs_provider ON ingestion_runs(provider, started_at);

CREATE TABLE ingestion_checkpoints (
  provider TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (provider, key)
);

CREATE TABLE review_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('question','incident','reference','source','day','benchmark','import')),
  entity_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human','policy','service','system')),
  actor_id TEXT NOT NULL,
  policy_version TEXT,
  details TEXT,                              -- JSON
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_review_log_entity ON review_log(entity_type, entity_id);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  response_summary TEXT NOT NULL,            -- JSON response replayed on retry
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
