-- The team records the onboarding gave the brain's records for each roster
-- team (`team-<id>`) before the company's teams became a source of the new
-- Brain (GRA-1748). Nothing writes them any more: the Brain page reads the
-- roster's teams from the onboarding's store, and a roster team is the
-- onboarding's, never a record. Only the onboarding ever took a `team-` id
-- (`brainRecordInputSchema`). Nothing is released (hard cut): removed.
-- Changes nothing run again.
DELETE FROM `brain_records` WHERE `type` = 'team' AND `id` LIKE 'team-%';
