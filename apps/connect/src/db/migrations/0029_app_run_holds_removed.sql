-- Apps run no workflows of their own (GRA-1367): no call works in an App
-- run's context (`run`) any more, and a held action of one names a run
-- that is gone, which nothing would ever decide, drop or list. They go.
-- Run again, it changes nothing.
DELETE FROM `pending_actions` WHERE json_extract(`context`, '$.type') = 'run';
