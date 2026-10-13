CREATE TABLE `mail_domains` (
	`domain` text PRIMARY KEY NOT NULL,
	`first_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_effect_stamps` (
	`key` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`origin` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_effect_stamps_origin_idx` ON `run_effect_stamps` (`origin`);--> statement-breakpoint
CREATE INDEX `run_effect_stamps_run_idx` ON `run_effect_stamps` (`run_id`);