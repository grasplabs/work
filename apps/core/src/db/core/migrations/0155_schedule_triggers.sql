CREATE TABLE `trigger_schedules` (
	`trigger_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`next_at` integer,
	`failed_starts` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` integer,
	FOREIGN KEY (`trigger_id`) REFERENCES `trigger_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `trigger_schedules_next_at` ON `trigger_schedules` (`next_at`) WHERE "trigger_schedules"."next_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `trigger_id` text;--> statement-breakpoint
ALTER TABLE `trigger_resource_versions` ADD `schedule_cron` text;--> statement-breakpoint
ALTER TABLE `trigger_resource_versions` ADD `schedule_time_zone` text;--> statement-breakpoint
ALTER TABLE `trigger_resource_versions` ADD `schedule_input` text;