CREATE TABLE `sdk_file_chunks` (
	`file_id` text NOT NULL,
	`index` integer NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`key` text NOT NULL,
	PRIMARY KEY(`file_id`, `index`),
	FOREIGN KEY (`file_id`) REFERENCES `sdk_files`(`file_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sdk_file_chunks_key` ON `sdk_file_chunks` (`key`);--> statement-breakpoint
CREATE TABLE `sdk_file_delete_keys` (
	`owner_id` text NOT NULL,
	`key` text NOT NULL,
	`file_id` text NOT NULL,
	PRIMARY KEY(`owner_id`, `key`),
	FOREIGN KEY (`file_id`) REFERENCES `sdk_files`(`file_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sdk_file_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sdk_file_refs` (
	`table_id` text NOT NULL,
	`record_id` text NOT NULL,
	`file_id` text NOT NULL,
	PRIMARY KEY(`table_id`, `record_id`, `file_id`),
	FOREIGN KEY (`file_id`) REFERENCES `sdk_files`(`file_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sdk_file_refs_file` ON `sdk_file_refs` (`file_id`);--> statement-breakpoint
CREATE TABLE `sdk_file_writes` (
	`key` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`issued_at` integer NOT NULL,
	`condemned` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `sdk_files`(`file_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sdk_file_writes_issued` ON `sdk_file_writes` (`issued_at`);--> statement-breakpoint
CREATE TABLE `sdk_files` (
	`file_id` text PRIMARY KEY NOT NULL,
	`resource` text NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`published_at` integer,
	`deleted_at` integer,
	`deleted_how` text,
	`begin_key` text NOT NULL,
	`expires_at` integer,
	`purged_at` integer
);
--> statement-breakpoint
CREATE INDEX `sdk_files_expiring` ON `sdk_files` (`expires_at`) WHERE expires_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX `sdk_files_unpurged` ON `sdk_files` (`deleted_at`) WHERE state = 'deleted' AND purged_at IS NULL;--> statement-breakpoint
CREATE INDEX `sdk_files_owner_open` ON `sdk_files` (`owner_id`) WHERE state = 'uploading';--> statement-breakpoint
CREATE INDEX `sdk_files_live` ON `sdk_files` (`owner_id`,`state`,`expires_at`,`size`) WHERE state <> 'deleted';--> statement-breakpoint
CREATE UNIQUE INDEX `sdk_files_begin_key` ON `sdk_files` (`owner_id`,`begin_key`);