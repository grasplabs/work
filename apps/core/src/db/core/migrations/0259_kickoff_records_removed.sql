-- The rows the kickoff gave the brain's records before it became a source
-- of the new Brain (GRA-1748): its visions, the teams it named and their
-- sizes, retired ones too, by their ids (`onb-vis-`, `onb-kt-`, `onb-kc-`).
-- Nothing writes them any more and nothing erases them: the admin's delete
-- of the kickoff now erases its source in the new Brain. Nothing is
-- released (hard cut): removed, words of replaced transcripts with them.
-- `GLOB`, not `LIKE`: it matches case, so no id an admin chose in another
-- case is touched. Changes nothing run again.
DELETE FROM `brain_records` WHERE `id` GLOB 'onb-vis-*' OR `id` GLOB 'onb-kt-*' OR `id` GLOB 'onb-kc-*';
