CREATE TABLE `entities` (
	`row` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entities_id_unique` ON `entities` (`id`);--> statement-breakpoint
CREATE INDEX `entities_kind_idx` ON `entities` (`kind`,`row`);--> statement-breakpoint
CREATE TABLE `entity_names` (
	`entity` integer NOT NULL,
	`memory` integer NOT NULL,
	`type` text NOT NULL,
	`value` text NOT NULL,
	`folded` text NOT NULL,
	PRIMARY KEY(`entity`, `memory`, `type`, `folded`),
	FOREIGN KEY (`entity`) REFERENCES `entities`(`row`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`memory`) REFERENCES `memories`(`row`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `entity_names_folded_idx` ON `entity_names` (`type`,`folded`,`entity`);--> statement-breakpoint
CREATE INDEX `entity_names_memory_idx` ON `entity_names` (`memory`);--> statement-breakpoint
CREATE TABLE `memories` (
	`row` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`entity` integer NOT NULL,
	`attribute` text,
	`object` integer,
	`value` text,
	`value_key` text,
	`one_value` integer NOT NULL,
	`type` text NOT NULL,
	`statement` text NOT NULL,
	`quote` text,
	`source` text,
	`version` integer,
	`subject` text,
	`writer` text,
	`lineage` text NOT NULL,
	`lineage_order` integer NOT NULL,
	`speaker` text NOT NULL,
	`valid_from` integer,
	`valid_until` integer,
	`learned_at` integer NOT NULL,
	`retired_at` integer,
	`readers` text NOT NULL,
	`only_for` text,
	FOREIGN KEY (`entity`) REFERENCES `entities`(`row`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`object`) REFERENCES `entities`(`row`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memories_id_unique` ON `memories` (`id`);--> statement-breakpoint
CREATE INDEX `memories_entity_idx` ON `memories` (`entity`,`attribute`,`lineage`);--> statement-breakpoint
CREATE INDEX `memories_object_idx` ON `memories` (`object`);--> statement-breakpoint
CREATE INDEX `memories_version_idx` ON `memories` (`source`,`version`);--> statement-breakpoint
CREATE INDEX `memories_subject_idx` ON `memories` (`subject`,`version`);--> statement-breakpoint
CREATE INDEX `memories_readers_idx` ON `memories` (`readers`);--> statement-breakpoint
CREATE INDEX `memories_only_for_idx` ON `memories` (`only_for`);--> statement-breakpoint
CREATE TABLE `memory_changes` (
	`key` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`answer` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_confirmations` (
	`row` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`memory` integer NOT NULL,
	`person` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`memory`) REFERENCES `memories`(`row`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `memory_confirmations_memory_idx` ON `memory_confirmations` (`memory`);--> statement-breakpoint
CREATE TABLE `memory_confirmed_over` (
	`confirmation` integer NOT NULL,
	`memory` integer NOT NULL,
	PRIMARY KEY(`confirmation`, `memory`),
	FOREIGN KEY (`confirmation`) REFERENCES `memory_confirmations`(`row`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`memory`) REFERENCES `memories`(`row`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `memory_confirmed_over_memory_idx` ON `memory_confirmed_over` (`memory`);--> statement-breakpoint
CREATE TABLE `memory_extractions` (
	`source` text NOT NULL,
	`version` integer NOT NULL,
	`subject` text NOT NULL,
	`lineage` text NOT NULL,
	`at` integer NOT NULL,
	`readers` text NOT NULL,
	`only_for` text,
	PRIMARY KEY(`source`, `version`, `readers`)
);
--> statement-breakpoint
CREATE INDEX `memory_extractions_lineage_idx` ON `memory_extractions` (`lineage`,`version`);--> statement-breakpoint
CREATE INDEX `memory_extractions_readers_idx` ON `memory_extractions` (`readers`);--> statement-breakpoint
CREATE INDEX `memory_extractions_subject_idx` ON `memory_extractions` (`subject`,`version`);--> statement-breakpoint
CREATE INDEX `memory_extractions_only_for_idx` ON `memory_extractions` (`only_for`);--> statement-breakpoint
ALTER TABLE `word_index` ADD `memory_cursor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- A memory's words and stems, as a chunk's (0005, 0006): its statement
-- as search reads it (words.ts `indexedOf`), written with the memory and
-- deleted with it, its terms gone from the index's pages at once.
CREATE VIRTUAL TABLE `memory_words` USING fts5(
	text,
	tokenize = 'unicode61 remove_diacritics 2 categories ''L* N* Co M*'''
);
--> statement-breakpoint
INSERT INTO `memory_words` (`memory_words`, `rank`) VALUES ('secure-delete', 1);
--> statement-breakpoint
CREATE VIRTUAL TABLE `memory_stems` USING fts5(
	stems,
	tokenize = 'unicode61 remove_diacritics 2 categories ''L* N* Co M*'''
);
--> statement-breakpoint
INSERT INTO `memory_stems` (`memory_stems`, `rank`) VALUES ('secure-delete', 1);
--> statement-breakpoint
CREATE TRIGGER `memories_words_delete` AFTER DELETE ON `memories` BEGIN
	DELETE FROM `memory_words` WHERE rowid = OLD.`row`;
	DELETE FROM `memory_stems` WHERE rowid = OLD.`row`;
END;
--> statement-breakpoint
-- Never overwritten: a memory is ended by a newer one of its lineage,
-- read as such, and only the moment it is retired is ever written, once.
CREATE TRIGGER `memories_no_update` BEFORE UPDATE ON `memories`
WHEN OLD.`retired_at` IS NOT NULL
	OR NEW.`id` IS NOT OLD.`id` OR NEW.`entity` IS NOT OLD.`entity`
	OR NEW.`attribute` IS NOT OLD.`attribute` OR NEW.`object` IS NOT OLD.`object`
	OR NEW.`value` IS NOT OLD.`value` OR NEW.`value_key` IS NOT OLD.`value_key`
	OR NEW.`one_value` IS NOT OLD.`one_value` OR NEW.`type` IS NOT OLD.`type`
	OR NEW.`statement` IS NOT OLD.`statement` OR NEW.`quote` IS NOT OLD.`quote`
	OR NEW.`source` IS NOT OLD.`source` OR NEW.`version` IS NOT OLD.`version`
	OR NEW.`subject` IS NOT OLD.`subject` OR NEW.`writer` IS NOT OLD.`writer`
	OR NEW.`lineage` IS NOT OLD.`lineage` OR NEW.`lineage_order` IS NOT OLD.`lineage_order`
	OR NEW.`speaker` IS NOT OLD.`speaker` OR NEW.`valid_from` IS NOT OLD.`valid_from`
	OR NEW.`valid_until` IS NOT OLD.`valid_until` OR NEW.`learned_at` IS NOT OLD.`learned_at`
	OR NEW.`readers` IS NOT OLD.`readers` OR NEW.`only_for` IS NOT OLD.`only_for`
BEGIN
	SELECT RAISE(ABORT, 'memories are added, never written over');
END;
