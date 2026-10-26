-- The full-text index of memory records (GRA-298): FTS5, which Drizzle
-- can't describe, kept in step with `brain_memories` by triggers in the
-- statement of each write, so a correction, retirement or purge never
-- leaves the old words to match. Rows are keyed by `brain_memory_rows`,
-- whose integer ids are stable, as `search_rows` keys sections.
CREATE TABLE `brain_memory_rows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`memory_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brain_memory_rows_memory_idx` ON `brain_memory_rows` (`memory_id`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `brain_memory_words` USING fts5(
	statement,
	tokenize = 'unicode61 remove_diacritics 2',
	prefix = '2 3'
);
--> statement-breakpoint
INSERT INTO `brain_memory_words` (`brain_memory_words`, `rank`) VALUES ('secure-delete', 1);
--> statement-breakpoint
CREATE TRIGGER `brain_memories_search_insert` AFTER INSERT ON `brain_memories` BEGIN
	INSERT INTO `brain_memory_rows` (`memory_id`) VALUES (new.`id`);
	INSERT INTO `brain_memory_words` (rowid, statement)
	SELECT `id`, new.`statement` FROM `brain_memory_rows` WHERE `memory_id` = new.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `brain_memories_search_update` AFTER UPDATE OF `statement` ON `brain_memories` BEGIN
	DELETE FROM `brain_memory_words` WHERE rowid = (
		SELECT `id` FROM `brain_memory_rows` WHERE `memory_id` = old.`id`
	);
	INSERT INTO `brain_memory_words` (rowid, statement)
	SELECT `id`, new.`statement` FROM `brain_memory_rows` WHERE `memory_id` = new.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `brain_memories_search_delete` AFTER DELETE ON `brain_memories` BEGIN
	DELETE FROM `brain_memory_words` WHERE rowid = (
		SELECT `id` FROM `brain_memory_rows` WHERE `memory_id` = old.`id`
	);
	DELETE FROM `brain_memory_rows` WHERE `memory_id` = old.`id`;
END;
