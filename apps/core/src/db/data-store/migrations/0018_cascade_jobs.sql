CREATE TABLE `sdk_cascade_jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`principal` text NOT NULL,
	`resource_id` text,
	`root_table_id` text NOT NULL,
	`root_record_id` text NOT NULL,
	`planned` integer NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE TABLE `sdk_cascade_members` (
	`table_id` text NOT NULL,
	`record_id` text NOT NULL,
	`job_id` text NOT NULL,
	PRIMARY KEY(`table_id`, `record_id`),
	FOREIGN KEY (`job_id`) REFERENCES `sdk_cascade_jobs`(`job_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sdk_cascade_members_job` ON `sdk_cascade_members` (`job_id`);