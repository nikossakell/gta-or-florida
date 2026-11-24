-- Approval provenance (2026-11-24).
-- Each approved question records HOW it was approved and WHICH audit row approved it, so the
-- scheduler and the public endpoint can check the approval itself, not just quality_state.
--   approval_mode   'licensed'        : source reuse rights (owner-approved source) — unchanged rules
--                   'factual_summary' : Independent Factual Summary (human-written, attested facts)
--   approval_log_id review_log row of the approval currently in force (cleared on revoke)

ALTER TABLE questions ADD COLUMN approval_mode TEXT CHECK (approval_mode IN ('licensed','factual_summary'));
-- No FOREIGN KEY: review_log is append-only audit; eligibility verifies the row belongs to the question.
ALTER TABLE questions ADD COLUMN approval_log_id INTEGER;

-- Backfill: an approved/retired question points at its latest approval decision in the audit log.
-- Questions without such a row stay NULL and are therefore never scheduled or served.
UPDATE questions
   SET approval_log_id = (
         SELECT MAX(l.id) FROM review_log l
          WHERE l.entity_type = 'question' AND l.entity_id = questions.id
            AND l.decision IN ('approved', 'approved:factual_summary', 'import:approved'))
 WHERE quality_state IN ('approved','retired');

UPDATE questions
   SET approval_mode = CASE (SELECT l.decision FROM review_log l WHERE l.id = questions.approval_log_id)
                         WHEN 'approved:factual_summary' THEN 'factual_summary'
                         ELSE 'licensed' END
 WHERE approval_log_id IS NOT NULL;
