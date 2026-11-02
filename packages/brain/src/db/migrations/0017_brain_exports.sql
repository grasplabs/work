CREATE TABLE `brain_export_files` (
	`export_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`sha256` text NOT NULL,
	`bytes` integer NOT NULL,
	`rows` integer NOT NULL,
	`cursor` text,
	`object` text NOT NULL,
	`stored` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`export_id`, `name`),
	FOREIGN KEY (`export_id`) REFERENCES `brain_exports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `brain_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`by` text NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`expires_at` integer,
	`manifest_sha256` text,
	`manifest_object` text,
	`collection_ids` text NOT NULL,
	`purge_mark` integer NOT NULL,
	`claim` text,
	`claimed_at` integer
);
--> statement-breakpoint
CREATE INDEX `brain_exports_state_idx` ON `brain_exports` (`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `brain_exports_running_idx` ON `brain_exports` (`state`) WHERE "brain_exports"."state" = 'running';