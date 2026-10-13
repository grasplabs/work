CREATE TABLE `mail_domains` (
	`domain` text PRIMARY KEY NOT NULL,
	`first_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_mail_stamps` (
	`token` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`origin` text NOT NULL,
	`address` text NOT NULL,
	`senders` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_mail_stamps_origin_idx` ON `run_mail_stamps` (`origin`);--> statement-breakpoint
CREATE INDEX `run_mail_stamps_run_idx` ON `run_mail_stamps` (`run_id`);