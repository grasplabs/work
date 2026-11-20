-- `erasures` made anew to take a third kind, a writer's erasure (its
-- CHECK can't be changed in place). Generated, then reordered by hand: a
-- Durable Object runs every migration in one transaction, where
-- `PRAGMA foreign_keys = OFF` does nothing, and the rows of
-- `erasing_versions` and `erased_versions` point at `erasures`. So the
-- references are checked at the end of the transaction, and the rows are
-- kept aside, the table dropped and made again, and the rows put back
-- into it with their own rowids (where replays and sweeps keep their
-- place): the references hold again by then. Renaming a new table into
-- place instead leaves them counted as broken, and the store never
-- starts.
PRAGMA defer_foreign_keys = ON;--> statement-breakpoint
CREATE TABLE `__kept_erasures` AS SELECT rowid AS `kept_rowid`, * FROM `erasures`;--> statement-breakpoint
DROP TABLE `erasures`;--> statement-breakpoint
CREATE TABLE `erasures` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`reason` text NOT NULL,
	`erased_at` integer NOT NULL,
	`confirmed` integer DEFAULT false NOT NULL,
	`sources` integer,
	`memories` integer,
	CONSTRAINT "erasures_kind" CHECK("erasures"."kind" IN ('source', 'person', 'writer'))
);
--> statement-breakpoint
INSERT INTO `erasures`(rowid, "key", "kind", "subject", "reason", "erased_at", "confirmed", "sources", "memories") SELECT "kept_rowid", "key", "kind", "subject", "reason", "erased_at", "confirmed", "sources", "memories" FROM `__kept_erasures`;--> statement-breakpoint
DROP TABLE `__kept_erasures`;--> statement-breakpoint
CREATE INDEX `erasures_subject_idx` ON `erasures` (`kind`,`subject`);--> statement-breakpoint
CREATE INDEX `erasures_unconfirmed_idx` ON `erasures` (`key`) WHERE confirmed = 0;--> statement-breakpoint
-- Its triggers went with the old table (0006): made again, as they were.
-- An erasure is recorded once and never changed, only confirmed once its
-- ledger entry is in the bucket; never deleted, as it closes a source's
-- key and hides a writer's memories learned before it.
CREATE TRIGGER `erasures_no_update` BEFORE UPDATE OF `key`, `kind`, `subject`, `reason`, `erased_at` ON `erasures` BEGIN
	SELECT RAISE(ABORT, 'erasures are recorded, never changed but confirmed');
END;
--> statement-breakpoint
CREATE TRIGGER `erasures_no_delete` BEFORE DELETE ON `erasures` BEGIN
	SELECT RAISE(ABORT, 'erasures are recorded, never deleted');
END;
