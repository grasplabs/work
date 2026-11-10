-- Apps run no workflows of their own (GRA-1367): no call works in an App
-- run's context (`run`) any more, and a held action of one names a run
-- that is gone, which nothing would ever decide, drop or list. They go,
-- unaudited: core's retention, which would have dropped each as
-- `run.ended`, no longer names those runs. The inputs of their calls of
-- unknown outcome go too, as that retention would have taken them; the
-- calls stay listed, by what they were. Run again, it changes nothing.
DELETE FROM `pending_actions` WHERE json_extract(`context`, '$.type') = 'run';--> statement-breakpoint
UPDATE `idempotent_calls` SET `input` = NULL WHERE `input` IS NOT NULL AND json_extract(`origin`, '$.context.type') = 'run';
