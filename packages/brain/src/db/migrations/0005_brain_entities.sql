CREATE TABLE `brain_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `brain_entity_keys` (
	`key_hash` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `brain_entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `brain_entity_keys_entity_idx` ON `brain_entity_keys` (`entity_id`);--> statement-breakpoint
CREATE TABLE `brain_link_jobs` (
	`source` text PRIMARY KEY NOT NULL,
	`document_id` text,
	`memory_id` text,
	`version` integer NOT NULL,
	`linked_version` integer,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`failure` text,
	`run` integer DEFAULT 0 NOT NULL,
	`failed_at` integer,
	`partial` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`memory_id`) REFERENCES `brain_memories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `brain_link_jobs_state_idx` ON `brain_link_jobs` (`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `brain_link_jobs_document_idx` ON `brain_link_jobs` (`document_id`);--> statement-breakpoint
CREATE INDEX `brain_link_jobs_memory_idx` ON `brain_link_jobs` (`memory_id`);--> statement-breakpoint
CREATE TABLE `brain_mentions` (
	`source` text NOT NULL,
	`position` integer NOT NULL,
	`document_id` text,
	`memory_id` text,
	`version` integer NOT NULL,
	`partition` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`alias` text NOT NULL,
	`entity_id` text,
	`state` text NOT NULL,
	`resolution` text NOT NULL,
	`candidates` text NOT NULL,
	PRIMARY KEY(`source`, `position`),
	FOREIGN KEY (`source`) REFERENCES `brain_link_jobs`(`source`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entity_id`) REFERENCES `brain_entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `brain_mentions_entity_idx` ON `brain_mentions` (`entity_id`);--> statement-breakpoint
CREATE INDEX `brain_mentions_alias_idx` ON `brain_mentions` (`partition`,`kind`,`alias`);