-- The statements the onboarding gave the brain's records, one for each
-- team claim (GRA-1748): the onboarding keeps its claims itself now
-- (`brain_claims`), and the Brain page and the new Brain read them there.
-- Nothing writes or erases these rows any more. Nothing is released (hard
-- cut): removed, words and all. `GLOB`, not `LIKE`: it matches case, so
-- no id an admin chose in another case is touched. Changes nothing run
-- again.
DELETE FROM `brain_records` WHERE `type` = 'statement' AND `id` GLOB 'onb-st-*';
