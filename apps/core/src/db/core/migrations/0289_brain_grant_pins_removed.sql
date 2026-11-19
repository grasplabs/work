-- Every agent reads the Brain with no grant (GRA-2203), so a run a chat
-- started no longer rests on one: the `brain-grant` pin goes, here and in
-- the Workspace's `chat_run_sources`. A run's host withholds a source it
-- can't name, so a run left holding it would be withheld for good. The
-- release before reads a run without the pin as one whose chat read no
-- grant: safe to roll back.
DELETE FROM `run_chat_sources` WHERE `source_id` = 'brain-grant';
