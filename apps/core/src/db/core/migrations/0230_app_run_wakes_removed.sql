-- Apps run no workflows of their own (GRA-1367): a wake owed to an App's
-- run (`run_id`) names a run nothing runs, and core sends wakes to
-- independent runs alone (workflows/wakes.ts). They go. Run again, it
-- changes nothing.
DELETE FROM `workflow_run_wakes` WHERE `resource_run_id` IS NULL;
