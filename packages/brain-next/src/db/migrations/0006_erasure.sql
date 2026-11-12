CREATE TABLE `erased_versions` (
	`erasure` text NOT NULL,
	`subject` text NOT NULL,
	`version` integer NOT NULL,
	PRIMARY KEY(`erasure`, `subject`, `version`),
	FOREIGN KEY (`erasure`) REFERENCES `erasures`(`key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `erased_versions_subject_idx` ON `erased_versions` (`subject`,`version`);--> statement-breakpoint
CREATE TABLE `erasing_versions` (
	`version_row` integer PRIMARY KEY NOT NULL,
	`erasure` text NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`version_row`) REFERENCES `source_versions`(`row`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`erasure`) REFERENCES `erasures`(`key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `erasing_versions_erasure_idx` ON `erasing_versions` (`erasure`);--> statement-breakpoint
CREATE INDEX `erasing_versions_next_idx` ON `erasing_versions` (`failures`,`version_row`);--> statement-breakpoint
CREATE TABLE `erasures` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`reason` text NOT NULL,
	`erased_at` integer NOT NULL,
	`confirmed` integer DEFAULT false NOT NULL,
	CONSTRAINT "erasures_kind" CHECK("erasures"."kind" IN ('source', 'person'))
);
--> statement-breakpoint
CREATE INDEX `erasures_subject_idx` ON `erasures` (`kind`,`subject`);--> statement-breakpoint
CREATE INDEX `erasures_unconfirmed_idx` ON `erasures` (`key`) WHERE confirmed = 0;--> statement-breakpoint
CREATE TABLE `source_subjects` (
	`source` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `source_subjects_subject_idx` ON `source_subjects` (`subject`);--> statement-breakpoint
-- The first slice's sources (GRA-1720), unread and unwritten since
-- versions (0002): a place content could be, whose contentless index can't
-- erase. Dropped, with their triggers and their words.
DROP TABLE `sources`;--> statement-breakpoint
DROP TABLE `source_words`;--> statement-breakpoint
-- The word indexes again, as ordinary FTS5 tables: each keeps its own copy
-- of what it indexed (a chunk's folded words, its stems; never the chunk's
-- text as written), so a delete knows the terms to take out, and with
-- `secure-delete` on it takes them out of the stored pages at once. As
-- contentless tables (0002, 0005) a delete left the terms' bytes in the
-- pages until FTS5 merged them away: what an erasure must not leave. Made
-- empty: the store rebuilds them from its chunks a batch a tick (words.ts
-- `reindexWords`), its rules number set to 0 below, which no rules are.
DROP TRIGGER `chunks_words_delete`;--> statement-breakpoint
DROP TRIGGER `chunks_stems_delete`;--> statement-breakpoint
DROP TABLE `chunk_words`;--> statement-breakpoint
DROP TABLE `chunk_stems`;--> statement-breakpoint
CREATE VIRTUAL TABLE `chunk_words` USING fts5(
	text,
	tokenize = 'unicode61 remove_diacritics 2 categories ''L* N* Co M*'''
);
--> statement-breakpoint
INSERT INTO `chunk_words` (`chunk_words`, `rank`) VALUES ('secure-delete', 1);
--> statement-breakpoint
CREATE VIRTUAL TABLE `chunk_stems` USING fts5(
	stems,
	tokenize = 'unicode61 remove_diacritics 2 categories ''L* N* Co M*'''
);
--> statement-breakpoint
INSERT INTO `chunk_stems` (`chunk_stems`, `rank`) VALUES ('secure-delete', 1);
--> statement-breakpoint
CREATE TRIGGER `chunks_words_delete` AFTER DELETE ON `chunks` BEGIN
	DELETE FROM `chunk_words` WHERE rowid = OLD.`row`;
END;
--> statement-breakpoint
CREATE TRIGGER `chunks_stems_delete` AFTER DELETE ON `chunks` BEGIN
	DELETE FROM `chunk_stems` WHERE rowid = OLD.`row`;
END;
--> statement-breakpoint
UPDATE `word_index` SET `version` = 0, `target` = 0, `cursor` = 0 WHERE `id` = 1;
--> statement-breakpoint
-- An erasure is recorded once and never changed, only confirmed once its
-- ledger entry is in the bucket; never deleted, as it closes a source's
-- key.
CREATE TRIGGER `erasures_no_update` BEFORE UPDATE OF `key`, `kind`, `subject`, `reason`, `erased_at` ON `erasures` BEGIN
	SELECT RAISE(ABORT, 'erasures are recorded, never changed but confirmed');
END;
--> statement-breakpoint
CREATE TRIGGER `erasures_no_delete` BEFORE DELETE ON `erasures` BEGIN
	SELECT RAISE(ABORT, 'erasures are recorded, never deleted');
END;
--> statement-breakpoint
-- What a person's erasure hid is its ledger entry: never changed or
-- deleted.
CREATE TRIGGER `erased_versions_no_update` BEFORE UPDATE ON `erased_versions` BEGIN
	SELECT RAISE(ABORT, 'erased versions are recorded, never changed');
END;
--> statement-breakpoint
CREATE TRIGGER `erased_versions_no_delete` BEFORE DELETE ON `erased_versions` BEGIN
	SELECT RAISE(ABORT, 'erased versions are recorded, never deleted');
END;
--> statement-breakpoint
-- The work queue's items again, their ids never used twice (AUTOINCREMENT):
-- an erasure deletes the row of an item under way, and its handler's
-- settling, by id, must never reach an item added after it. Nothing points
-- at the table, so it is made anew and its rows copied.
CREATE TABLE `__new_work_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`payload` text NOT NULL,
	`priority` integer NOT NULL,
	`connection` text,
	`added_at` integer NOT NULL,
	`not_before` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`parks` integer DEFAULT 0 NOT NULL,
	`running` integer DEFAULT false NOT NULL,
	`interrupted` integer DEFAULT false NOT NULL,
	`parked_at` integer,
	`last_error` text,
	CONSTRAINT "work_items_priority" CHECK(priority BETWEEN 0 AND 4)
);
--> statement-breakpoint
INSERT INTO `__new_work_items`("id", "kind", "key", "payload", "priority", "connection", "added_at", "not_before", "attempts", "parks", "running", "interrupted", "parked_at", "last_error") SELECT "id", "kind", "key", "payload", "priority", "connection", "added_at", "not_before", "attempts", "parks", "running", "interrupted", "parked_at", "last_error" FROM `work_items`;--> statement-breakpoint
DROP TABLE `work_items`;--> statement-breakpoint
ALTER TABLE `__new_work_items` RENAME TO `work_items`;--> statement-breakpoint
CREATE UNIQUE INDEX `work_items_waiting_key` ON `work_items` (`kind`,`key`) WHERE running = 0;--> statement-breakpoint
CREATE INDEX `work_items_running_idx` ON `work_items` (`kind`,`key`,`connection`,`interrupted`) WHERE running = 1;--> statement-breakpoint
CREATE INDEX `work_items_waiting_idx` ON `work_items` (`connection`,`priority`,`id`) WHERE running = 0 AND parked_at IS NULL AND interrupted = 0;--> statement-breakpoint
CREATE INDEX `work_items_interrupted_idx` ON `work_items` (`priority`,`id`) WHERE running = 0 AND parked_at IS NULL AND interrupted = 1;--> statement-breakpoint
CREATE INDEX `work_items_parked_idx` ON `work_items` (`parked_at`,`id`) WHERE parked_at IS NOT NULL;--> statement-breakpoint
-- Every vector table cleared before a mark names its chunk: no embedding
-- model ships yet, and only tests and staging wrote codes, which the
-- embedding queue writes again. So no mark is left that an erasure can't
-- trace to its chunk, and no set of readers outlives a block it can't find.
DELETE FROM `vector_removed`;--> statement-breakpoint
DELETE FROM `vector_codes`;--> statement-breakpoint
DELETE FROM `vector_blocks`;--> statement-breakpoint
DELETE FROM `vector_models`;--> statement-breakpoint
ALTER TABLE `vector_removed` ADD `chunk` integer;--> statement-breakpoint
CREATE INDEX `vector_removed_chunk_idx` ON `vector_removed` (`chunk`);