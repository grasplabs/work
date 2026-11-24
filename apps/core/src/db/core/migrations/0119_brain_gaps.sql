CREATE TABLE `brain_gap_states` (
	`gap_id` text PRIMARY KEY NOT NULL,
	`asked_at` integer,
	`closed_at` integer,
	`answer` text,
	`answered_by` text
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`type` text NOT NULL,
	`app_id` text,
	`workflow_id` text,
	`run_id` text,
	`failures` integer,
	`gap_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`read_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_notifications`("id", "person_id", "type", "app_id", "workflow_id", "run_id", "failures", "gap_id", "created_at", "updated_at", "read_at") SELECT "id", "person_id", "type", "app_id", "workflow_id", "run_id", "failures", NULL, "created_at", "updated_at", "read_at" FROM `notifications`;--> statement-breakpoint
DROP TABLE `notifications`;--> statement-breakpoint
ALTER TABLE `__new_notifications` RENAME TO `notifications`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `notifications_person_idx` ON `notifications` (`person_id`,`updated_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_unread_idx` ON `notifications` (`person_id`,`type`,`app_id`,`workflow_id`) WHERE read_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_gap_idx` ON `notifications` (`person_id`,`gap_id`) WHERE gap_id IS NOT NULL;