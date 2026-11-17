-- Who told what counts only for the team they told it in (GRA-1984): kept
-- as they agree. Null for an interview agreed to before, which so counts
-- for no team (hard cut: nothing is released).
ALTER TABLE `interview_states` ADD `told_in` text;--> statement-breakpoint
-- A team's work shows from the first person who told it, only in claims
-- that describe the work, checked to hold no judgment and with no count of
-- people (GRA-1987). Every claim and drawing standing now was made by the
-- earlier rule: each is owed its erasure, which core's clock finishes, and
-- a team's stand again at its next intake. Changes nothing run again.
UPDATE `brain_claims` SET `erase` = 1 WHERE `erase` = 0;--> statement-breakpoint
UPDATE `brain_drawings` SET `erase` = 1 WHERE `erase` = 0;
