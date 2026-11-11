CREATE TABLE `chunks` (
	`row` integer PRIMARY KEY NOT NULL,
	`version_row` integer NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`version_row`) REFERENCES `source_versions`(`row`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chunks_version_position_unique` ON `chunks` (`version_row`,`position`);--> statement-breakpoint
CREATE TABLE `current_versions` (
	`source` text PRIMARY KEY NOT NULL,
	`version_row` integer NOT NULL,
	FOREIGN KEY (`version_row`) REFERENCES `source_versions`(`row`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `current_versions_version_row_unique` ON `current_versions` (`version_row`);--> statement-breakpoint
CREATE TABLE `files` (
	`hash` text PRIMARY KEY NOT NULL,
	`refs` integer NOT NULL,
	`written_at` integer NOT NULL,
	CONSTRAINT "files_refs" CHECK("files"."refs" >= 0)
);
--> statement-breakpoint
CREATE INDEX `files_unreferenced_idx` ON `files` (`refs`,`written_at`);--> statement-breakpoint
CREATE TABLE `source_changes` (
	`source` text NOT NULL,
	`change` text NOT NULL,
	`version_row` integer NOT NULL,
	PRIMARY KEY(`source`, `change`),
	FOREIGN KEY (`version_row`) REFERENCES `source_versions`(`row`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `source_versions` (
	`row` integer PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`version` integer NOT NULL,
	`file` text NOT NULL,
	`reader_set` integer NOT NULL,
	`added_at` integer NOT NULL,
	FOREIGN KEY (`file`) REFERENCES `files`(`hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reader_set`) REFERENCES `reader_sets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `source_versions_reader_set_idx` ON `source_versions` (`reader_set`);--> statement-breakpoint
CREATE INDEX `source_versions_file_idx` ON `source_versions` (`file`);--> statement-breakpoint
CREATE UNIQUE INDEX `source_versions_source_version_unique` ON `source_versions` (`source`,`version`);--> statement-breakpoint
-- The words of every chunk, for recall (recall.ts): its text as search
-- reads it (words.ts `foldForSearch`), written by the store in the same
-- transaction as the chunk. Contentless, as `source_words` (0001): the
-- chunk's text is in `chunks`, and recall reads back only the rowid. Recall
-- reads it from here on; `sources` and `source_words` are left for a later
-- migration to drop (expand, then contract).
CREATE VIRTUAL TABLE `chunk_words` USING fts5(
	text,
	content = '',
	contentless_delete = 1,
	tokenize = 'unicode61 remove_diacritics 2 categories ''L* N* Co M*'''
);
--> statement-breakpoint
CREATE TRIGGER `chunks_words_delete` AFTER DELETE ON `chunks` BEGIN
	DELETE FROM `chunk_words` WHERE rowid = OLD.`row`;
END;
--> statement-breakpoint
-- A version and its chunks are written once, never changed: a new version
-- is new rows, and the old one stays as it was, as history.
CREATE TRIGGER `source_versions_no_update` BEFORE UPDATE ON `source_versions` BEGIN
	SELECT RAISE(ABORT, 'source versions are added, never updated');
END;
--> statement-breakpoint
CREATE TRIGGER `chunks_no_update` BEFORE UPDATE ON `chunks` BEGIN
	SELECT RAISE(ABORT, 'chunks are added, never updated');
END;--> statement-breakpoint
-- A change keeps the version it was added as, for every retry of it.
CREATE TRIGGER `source_changes_no_update` BEFORE UPDATE ON `source_changes` BEGIN
	SELECT RAISE(ABORT, 'source changes are added, never updated');
END;
