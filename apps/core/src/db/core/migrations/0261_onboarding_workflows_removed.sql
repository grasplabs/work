-- The pieces of work and their drawings the onboarding gave the brain's
-- records (GRA-1748): the onboarding keeps its drawings itself now
-- (`brain_drawings`), and the Brain page and the new Brain read them
-- there. Only the onboarding ever wrote these types, and nothing writes
-- or erases these rows any more. Nothing is released (hard cut): removed,
-- words and all. `GLOB`, not `LIKE`: it matches case. Changes nothing run
-- again.
DELETE FROM `brain_records` WHERE `type` IN ('workflow', 'workflowVersion') AND `id` GLOB 'onb-*';
