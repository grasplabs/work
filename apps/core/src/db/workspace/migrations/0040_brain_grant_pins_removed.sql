-- Every agent reads the Brain with no grant (GRA-2203), so a run no longer
-- rests on one: the `brain-grant` pin goes, here and in core's
-- `run_chat_sources`. History withholds a source it can't name, so a run
-- left holding it would be withheld for good. The release before reads a
-- run without the pin as one that read no grant: safe to roll back.
DELETE FROM `chat_run_sources` WHERE `source_id` = 'brain-grant';--> statement-breakpoint
DELETE FROM `chat_sources` WHERE `source_id` = 'brain-grant';
