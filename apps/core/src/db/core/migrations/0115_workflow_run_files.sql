CREATE TABLE `workflow_run_file_chunks` (
	`file_id` text NOT NULL,
	`index` integer NOT NULL,
	`key` text NOT NULL,
	`append_key` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`stored` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`file_id`, `index`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_run_file_chunks_key_unique` ON `workflow_run_file_chunks` (`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_run_file_chunks_append_key_unique` ON `workflow_run_file_chunks` (`append_key`);--> statement-breakpoint
CREATE TABLE `workflow_run_files` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`workflow_resource_id` text NOT NULL,
	`opened_by` text NOT NULL,
	`open_key` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`sha256` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_run_files_open_key_unique` ON `workflow_run_files` (`open_key`);--> statement-breakpoint
CREATE INDEX `workflow_run_files_run_idx` ON `workflow_run_files` (`run_id`,`state`);--> statement-breakpoint
CREATE INDEX `workflow_run_files_workflow_idx` ON `workflow_run_files` (`workflow_resource_id`,`state`);--> statement-breakpoint
CREATE INDEX `workflow_run_files_writing_idx` ON `workflow_run_files` (`created_at`) WHERE "workflow_run_files"."state" = 'writing';--> statement-breakpoint
CREATE INDEX `workflow_run_files_deleted_idx` ON `workflow_run_files` (`deleted_at`) WHERE "workflow_run_files"."state" = 'deleted';