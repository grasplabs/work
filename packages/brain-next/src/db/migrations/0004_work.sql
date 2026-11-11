CREATE TABLE `work_items` (
	`id` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`payload` text NOT NULL,
	`priority` integer NOT NULL,
	`connection` text,
	`added_at` integer NOT NULL,
	`not_before` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`parks` integer DEFAULT 0 NOT NULL,
	`running` integer DEFAULT false NOT NULL,
	`interrupted` integer DEFAULT false NOT NULL,
	`parked_at` integer,
	`last_error` text,
	CONSTRAINT "work_items_priority" CHECK(priority BETWEEN 0 AND 4)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_items_waiting_key` ON `work_items` (`kind`,`key`) WHERE running = 0;--> statement-breakpoint
CREATE INDEX `work_items_running_idx` ON `work_items` (`kind`,`key`,`connection`,`interrupted`) WHERE running = 1;--> statement-breakpoint
CREATE INDEX `work_items_waiting_idx` ON `work_items` (`connection`,`priority`,`id`) WHERE running = 0 AND parked_at IS NULL AND interrupted = 0;--> statement-breakpoint
CREATE INDEX `work_items_interrupted_idx` ON `work_items` (`priority`,`id`) WHERE running = 0 AND parked_at IS NULL AND interrupted = 1;--> statement-breakpoint
CREATE INDEX `work_items_parked_idx` ON `work_items` (`parked_at`,`id`) WHERE parked_at IS NOT NULL;--> statement-breakpoint
CREATE TABLE `work_model_bucket` (
	`id` integer PRIMARY KEY NOT NULL,
	`tokens` real NOT NULL,
	`at` integer NOT NULL,
	`paused_until` integer NOT NULL,
	`paused_since` integer,
	`pause_reason` text,
	CONSTRAINT "work_model_bucket_one" CHECK(id = 1)
);
--> statement-breakpoint
ALTER TABLE `files` ADD `in_doubt_until` integer;