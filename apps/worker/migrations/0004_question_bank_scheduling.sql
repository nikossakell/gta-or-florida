-- 0004 — verified question bank + pseudo-randomized daily scheduling (2026-11-25).
--
--  * questions.event_id: questions describing the same underlying event share it. NULL = the
--    question's own incident (every existing question), so the scheduler uses
--    COALESCE(event_id, incident_id). The event cooldown and "one question per event per day" apply to it.
--  * questions.spoiler: 1 = left out of scheduling unless explicitly included.
--  * daily_rounds.florida_count may be 0-5 (each slot is drawn 50/50; the split is no longer fixed 2/3).
--  * daily_round_items: a question may appear again on a later day (after the event cooldown), so the
--    global UNIQUE(question_id) becomes UNIQUE(day, question_id).
--
-- SQLite cannot drop a constraint, so both round tables are rebuilt. Every existing row is copied
-- unchanged (published, scheduled and withdrawn days, numbers, order, audit fields); player progress
-- lives in browsers and is not touched. The order below never leaves a row without its parent: the new
-- items table references the new rounds table, the old tables are dropped child-first, and RENAME
-- rewrites the reference to the final name (SQLite >= 3.26, legacy_alter_table off).

ALTER TABLE questions ADD COLUMN event_id TEXT;
ALTER TABLE questions ADD COLUMN spoiler INTEGER NOT NULL DEFAULT 0 CHECK (spoiler IN (0,1));
CREATE INDEX idx_questions_event ON questions(event_id);

CREATE TABLE daily_rounds_v4 (
  day TEXT PRIMARY KEY CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  number INTEGER NOT NULL UNIQUE CHECK (number >= 1),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','published','withdrawn')),
  florida_count INTEGER NOT NULL CHECK (florida_count BETWEEN 0 AND 5),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  published_at TEXT,
  withdrawn_reason TEXT,
  public_message TEXT,
  content_version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO daily_rounds_v4 (day, number, status, florida_count, created_at, published_at, withdrawn_reason, public_message, content_version)
  SELECT day, number, status, florida_count, created_at, published_at, withdrawn_reason, public_message, content_version FROM daily_rounds;

CREATE TABLE daily_round_items_v4 (
  day TEXT NOT NULL REFERENCES daily_rounds_v4(day),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 5),
  question_id TEXT NOT NULL REFERENCES questions(id),
  PRIMARY KEY (day, position),
  UNIQUE (day, question_id)
);
INSERT INTO daily_round_items_v4 (day, position, question_id) SELECT day, position, question_id FROM daily_round_items;

DROP TABLE daily_round_items;
DROP TABLE daily_rounds;
ALTER TABLE daily_rounds_v4 RENAME TO daily_rounds;
ALTER TABLE daily_round_items_v4 RENAME TO daily_round_items;
CREATE INDEX idx_rounds_status ON daily_rounds(status, day);
CREATE INDEX idx_round_items_question ON daily_round_items(question_id);
