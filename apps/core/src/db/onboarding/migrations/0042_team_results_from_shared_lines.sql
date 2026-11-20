-- What the onboarding drew from interviews rests only on the lines people
-- chose to share with their team as how they work (GRA-1987). Everything
-- drawn before was drawn from lines that, with no choice made, are only
-- counted anonymously. Nothing is released (hard cut):
-- - each standing claim and drawing is owed its erasure, which core's
--   clock finishes;
-- - each lead's map no longer stands on what they approved: its pieces of
--   work reach no drawing, interview, review or team result until the map
--   is drawn again from the lines they share, and what the map said a team
--   does goes with it;
-- - each piece of work's drawing, and the differences checked in it, go:
--   it is drawn again from shared lines once its map stands.
-- A team's results stand again, from its shared lines alone, at its next
-- intake. Changes nothing run again.
UPDATE `brain_claims` SET `erase` = 1 WHERE `erase` = 0;--> statement-breakpoint
UPDATE `brain_drawings` SET `erase` = 1 WHERE `erase` = 0;--> statement-breakpoint
UPDATE `teams` SET `mapped_from` = NULL, `mapped_does` = NULL;--> statement-breakpoint
DELETE FROM `drawn_works`;--> statement-breakpoint
DELETE FROM `checked_differences`;
