CREATE TABLE `audit_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_outbox_rejected` (
	`seq` integer PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`event` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	`rejected_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_outbox_rejected_id` ON `audit_outbox_rejected` (`id`);--> statement-breakpoint
CREATE TABLE `brain_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`scope` text NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`statement` text NOT NULL,
	`source_refs` text NOT NULL,
	`state` text NOT NULL,
	`indexing_state` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `brain_memories_owner_idx` ON `brain_memories` (`owner_id`,`recorded_at`,`id`);--> statement-breakpoint
CREATE INDEX `brain_memories_owner_kind_idx` ON `brain_memories` (`owner_id`,`kind`,`recorded_at`,`id`);--> statement-breakpoint
CREATE TABLE `brain_payload_releases` (
	`key` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `brain_payloads` (
	`key` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`sha256` text NOT NULL,
	`bytes` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brain_payloads_committed_sha256_idx` ON `brain_payloads` (`collection_id`,`sha256`) WHERE "brain_payloads"."state" = 'committed';--> statement-breakpoint
CREATE INDEX `brain_payloads_state_idx` ON `brain_payloads` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `brain_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`key_hash` text NOT NULL,
	`caller` text NOT NULL,
	`operation` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text NOT NULL,
	`indexing_state` text NOT NULL,
	`resource_refs` text NOT NULL,
	`created_at` integer NOT NULL,
	`retention_until` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brain_receipts_key_idx` ON `brain_receipts` (`key_hash`);--> statement-breakpoint
CREATE INDEX `brain_receipts_retention_idx` ON `brain_receipts` (`retention_until`);--> statement-breakpoint
CREATE INDEX `brain_receipts_caller_idx` ON `brain_receipts` (`caller`,`created_at`);--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`owner` text NOT NULL,
	`access` text NOT NULL,
	`sensitive` integer DEFAULT false NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `collections_access_idx` ON `collections` (`access`);--> statement-breakpoint
CREATE INDEX `collections_owner_idx` ON `collections` (`owner`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`path` text NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`description` text NOT NULL,
	`owner` text NOT NULL,
	`tags` text NOT NULL,
	`review_date` text,
	`current_version` integer NOT NULL,
	`indexed_version` integer,
	`index_state` text DEFAULT 'queued' NOT NULL,
	`index_attempts` integer DEFAULT 0 NOT NULL,
	`index_failure` text,
	`index_run` integer DEFAULT 0 NOT NULL,
	`index_failed_at` integer,
	`index_purge_pending` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `documents_index_state_idx` ON `documents` (`index_state`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `documents_collection_path_idx` ON `documents` (`collection_id`,`path`);--> statement-breakpoint
CREATE INDEX `documents_updated_at_idx` ON `documents` (`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `documents_review_date_idx` ON `documents` (`review_date`,`id`) WHERE "documents"."review_date" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `links` (
	`from_document_id` text NOT NULL,
	`to_collection_id` text NOT NULL,
	`to_path` text NOT NULL,
	`label` text,
	PRIMARY KEY(`from_document_id`, `to_collection_id`, `to_path`),
	FOREIGN KEY (`from_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `links_to_idx` ON `links` (`to_collection_id`,`to_path`);--> statement-breakpoint
CREATE TABLE `search_rebuilds` (
	`id` text PRIMARY KEY NOT NULL,
	`owed_at` integer NOT NULL,
	`writes_done_at` integer
);
--> statement-breakpoint
CREATE TABLE `sections` (
	`document_id` text NOT NULL,
	`version` integer NOT NULL,
	`position` integer NOT NULL,
	`headings` text NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`document_id`, `position`),
	FOREIGN KEY (`document_id`,`version`) REFERENCES `versions`(`document_id`,`number`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `versions` (
	`document_id` text NOT NULL,
	`number` integer NOT NULL,
	`payload_key` text NOT NULL,
	`author` text NOT NULL,
	`message` text,
	`restored_from` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`document_id`, `number`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`payload_key`) REFERENCES `brain_payloads`(`key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `versions_payload_key_idx` ON `versions` (`payload_key`);--> statement-breakpoint
-- The full-text index, which Drizzle can't describe (db/schema.ts). Each
-- section has a row in `search_rows`, whose `id` is the rowid of its entry
-- in both FTS5 indexes: `search_words` (unicode61, words and their
-- prefixes) holds the text, and `search_trigrams` (substrings, for words
-- typed in part or with a typo) reads that same text from `search_words`'s
-- content table rather than keeping a copy. Both delete securely, so a
-- purged term leaves nothing in their pages (search-erasure.ts). Triggers
-- keep them in step with `sections`, which are replaced, never updated.
CREATE TABLE `search_rows` (
	`id` integer PRIMARY KEY,
	`document_id` text NOT NULL,
	`position` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_rows_section_idx` ON `search_rows` (`document_id`, `position`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `search_words` USING fts5(
	title, description, headings, text,
	tokenize = 'unicode61 remove_diacritics 2',
	prefix = '2 3'
);
--> statement-breakpoint
INSERT INTO `search_words` (`search_words`, `rank`) VALUES ('secure-delete', 1);
--> statement-breakpoint
CREATE VIRTUAL TABLE `search_trigrams` USING fts5(
	c0, c1, c2, c3,
	content = 'search_words_content',
	content_rowid = 'id',
	tokenize = 'trigram remove_diacritics 1'
);
--> statement-breakpoint
INSERT INTO `search_trigrams` (`search_trigrams`, `rank`) VALUES ('secure-delete', 1);
--> statement-breakpoint
CREATE TRIGGER `sections_search_update` BEFORE UPDATE ON `sections` BEGIN
	SELECT RAISE(ABORT, 'sections are replaced, never updated');
END;
--> statement-breakpoint
CREATE TRIGGER `sections_insert_key` BEFORE INSERT ON `sections`
WHEN EXISTS (
	SELECT 1 FROM `sections`
	WHERE `document_id` = NEW.`document_id` AND `position` = NEW.`position`
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: sections.document_id, sections.position (sections are deleted before they are written again)');
END;
--> statement-breakpoint
CREATE TRIGGER `sections_insert_rowid` BEFORE INSERT ON `sections`
WHEN EXISTS (
	SELECT 1 FROM `sections` WHERE rowid = NEW.rowid AND NEW.rowid <> -1
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: sections.rowid (sections are deleted before they are written again)');
END;
--> statement-breakpoint
CREATE TRIGGER `sections_rowid_reserved` AFTER INSERT ON `sections`
WHEN NEW.rowid = -1
BEGIN
	SELECT RAISE(ABORT, 'sections keep rowid -1 for an insert that names none');
END;
--> statement-breakpoint
CREATE TRIGGER `sections_search_insert` AFTER INSERT ON `sections` BEGIN
	INSERT INTO `search_rows` (`document_id`, `position`)
	VALUES (new.`document_id`, new.`position`);
	INSERT INTO `search_words` (rowid, title, description, headings, text)
	SELECT r.`id`, d.`title`, d.`description`,
		(SELECT group_concat(value, ' ') FROM json_each(new.`headings`)), new.`text`
	FROM `search_rows` r
	JOIN `documents` d ON d.`id` = r.`document_id`
	WHERE r.`document_id` = new.`document_id` AND r.`position` = new.`position`;
	INSERT INTO `search_trigrams` (rowid, c0, c1, c2, c3)
	SELECT w.rowid, w.title, w.description, w.headings, w.text
	FROM `search_words` w
	WHERE w.rowid = (
		SELECT `id` FROM `search_rows`
		WHERE `document_id` = new.`document_id` AND `position` = new.`position`
	);
END;
--> statement-breakpoint
CREATE TRIGGER `sections_search_delete` AFTER DELETE ON `sections` BEGIN
	DELETE FROM `search_trigrams` WHERE rowid = (
		SELECT `id` FROM `search_rows`
		WHERE `document_id` = old.`document_id` AND `position` = old.`position`
	);
	DELETE FROM `search_words` WHERE rowid = (
		SELECT `id` FROM `search_rows`
		WHERE `document_id` = old.`document_id` AND `position` = old.`position`
	);
	DELETE FROM `search_rows`
	WHERE `document_id` = old.`document_id` AND `position` = old.`position`;
END;
