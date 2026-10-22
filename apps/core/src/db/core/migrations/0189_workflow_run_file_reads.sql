CREATE TABLE `workflow_run_file_reads` (
	`subject_id` text NOT NULL,
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`action` text NOT NULL,
	`read_at` integer NOT NULL,
	PRIMARY KEY(`subject_id`, `user_id`, `day`, `action`)
);
--> statement-breakpoint
CREATE INDEX `workflow_run_file_reads_day_idx` ON `workflow_run_file_reads` (`day`);