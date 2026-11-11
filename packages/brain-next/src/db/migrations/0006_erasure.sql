CREATE TABLE `erasing_versions` (
	`version_row` integer PRIMARY KEY NOT NULL,
	`erasure` text NOT NULL,
	FOREIGN KEY (`version_row`) REFERENCES `source_versions`(`row`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`erasure`) REFERENCES `erasures`(`key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `erasing_versions_erasure_idx` ON `erasing_versions` (`erasure`);--> statement-breakpoint
CREATE TABLE `erasures` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`reason` text NOT NULL,
	`erased_at` integer NOT NULL,
	CONSTRAINT "erasures_kind" CHECK("erasures"."kind" IN ('source', 'person'))
);
--> statement-breakpoint
CREATE INDEX `erasures_subject_idx` ON `erasures` (`kind`,`subject`);--> statement-breakpoint
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
-- An erasure is applied once and never changed; a version an erasure hid
-- stays hidden until it is deleted.
CREATE TRIGGER `erasures_no_update` BEFORE UPDATE ON `erasures` BEGIN
	SELECT RAISE(ABORT, 'erasures are recorded, never updated');
END;
--> statement-breakpoint
CREATE TRIGGER `erasures_no_delete` BEFORE DELETE ON `erasures` BEGIN
	SELECT RAISE(ABORT, 'erasures are recorded, never deleted');
END;