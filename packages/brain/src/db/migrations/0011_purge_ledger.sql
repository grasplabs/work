CREATE TABLE `brain_purge_steps` (
	`purge_id` text NOT NULL,
	`step` text NOT NULL,
	`position` integer NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`reason` text,
	`counts` text,
	`claimed_at` integer,
	`claim` text,
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
	`superseded_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brain_purges_open_key_idx` ON `brain_purges` (`key`) WHERE "brain_purges"."completed_at" IS NULL AND "brain_purges"."superseded_by" IS NULL;--> statement-breakpoint
CREATE INDEX `brain_purges_created_idx` ON `brain_purges` (`created_at`);