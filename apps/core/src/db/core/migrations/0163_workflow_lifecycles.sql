CREATE TABLE `workflow_resource_lifecycles` (
	`workflow_resource_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`stage` text,
	`live_version` integer,
	`live_approved_by` text,
	`live_approved_at` integer,
	`paused_by` text,
	`paused_at` integer,
	`go_live_version` integer,
	`go_live_requested_by` text,
	`go_live_requested_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
