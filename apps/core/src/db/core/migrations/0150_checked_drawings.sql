-- GRA-1084: the onboarding's drawings in the brain held every part the
-- model drew, however few told it. The brain now holds only parts five or
-- more were checked to tell, so every drawing the onboarding gave it
-- before goes; the onboarding gives its teams again (its own migration
-- marks them due), and their workflows keep their ids.
DELETE FROM `brain_records` WHERE `type` = 'workflowVersion' AND `id` LIKE 'onb-%';
