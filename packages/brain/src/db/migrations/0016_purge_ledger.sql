CREATE TABLE `brain_purge_steps` (
	`purge_id` text NOT NULL,
	`step` text NOT NULL,
	`position` integer NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`reason` text,
	`counts` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`purge_id`, `step`),
	FOREIGN KEY (`purge_id`) REFERENCES `brain_purges`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `brain_purges` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`by` text NOT NULL,
	`counts` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`superseded_by` text,
	`attempt` text,
	`attempt_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brain_purges_open_key_idx` ON `brain_purges` (`key`) WHERE "brain_purges"."completed_at" IS NULL AND "brain_purges"."superseded_by" IS NULL;--> statement-breakpoint
CREATE INDEX `brain_purges_created_idx` ON `brain_purges` (`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_brain_erased_documents` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purge_id` text NOT NULL,
	`document_id` text NOT NULL,
	`place` text NOT NULL,
	`erased_at` integer NOT NULL,
	`done_at` integer
);
--> statement-breakpoint
-- Each record keeps its rowid as its sequence: marks taken from it stay right.
INSERT INTO `__new_brain_erased_documents`("seq", "purge_id", "document_id", "place", "erased_at", "done_at") SELECT "rowid", "purge_id", "document_id", "place", "erased_at", "done_at" FROM `brain_erased_documents`;--> statement-breakpoint
DROP TABLE `brain_erased_documents`;--> statement-breakpoint
ALTER TABLE `__new_brain_erased_documents` RENAME TO `brain_erased_documents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `brain_erased_documents_purge_document_idx` ON `brain_erased_documents` (`purge_id`,`document_id`);--> statement-breakpoint
CREATE INDEX `brain_erased_documents_place_idx` ON `brain_erased_documents` (`place`);