-- Versions keep compact metadata, and each one's text is an immutable
-- payload in R2 (knowledge/payloads.ts). Nothing is released, so this is a
-- hard cut: no text moves to R2. Every document goes, with its versions,
-- sections (whose triggers take their search rows), links and the App
-- entries' bookkeeping, so the Apps collection is indexed again and the
-- Grasp skills synced again; collections stay.
DELETE FROM `sections`;--> statement-breakpoint
DELETE FROM `links`;--> statement-breakpoint
DELETE FROM `versions`;--> statement-breakpoint
DELETE FROM `documents`;--> statement-breakpoint
DELETE FROM `app_entries`;--> statement-breakpoint
CREATE TABLE `brain_payload_releases` (
	`key` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `brain_payloads` (
	`key` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`bytes` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brain_payloads_committed_sha256_idx` ON `brain_payloads` (`sha256`) WHERE "brain_payloads"."state" = 'committed';--> statement-breakpoint
CREATE INDEX `brain_payloads_state_idx` ON `brain_payloads` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_versions` (
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
DROP TABLE `versions`;--> statement-breakpoint
ALTER TABLE `__new_versions` RENAME TO `versions`;--> statement-breakpoint
CREATE INDEX `versions_payload_key_idx` ON `versions` (`payload_key`);