-- The last of what the onboarding gave the brain's records (GRA-1748):
-- each roster team's record (`team-<id>`, its name once five of its people
-- agreed), and any row left under the onboarding's own ids. The
-- onboarding keeps what it learned itself, the Brain page shows a team as
-- the admin confirmed it, and nothing writes or erases these rows any
-- more. Only the onboarding ever
-- wrote either: `brain.addRecords` refuses both. Nothing is released (hard
-- cut): removed, words and all. `GLOB`, not `LIKE`: it matches case.
-- Changes nothing run again.
DELETE FROM `brain_records` WHERE `id` GLOB 'onb-*' OR (`type` = 'team' AND `id` GLOB 'team-*');
