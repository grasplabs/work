CREATE TABLE `connector_trigger_holds` (
	`trigger_id` text NOT NULL,
	`event_key` text NOT NULL,
	`held_since` integer NOT NULL,
	`settled` text,
	`settled_at` integer,
	PRIMARY KEY(`trigger_id`, `event_key`),
	FOREIGN KEY (`trigger_id`) REFERENCES `trigger_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `resource_run_mail_calls` (
	`origin` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`stamp` text NOT NULL,
	`recipients` text NOT NULL,
	`senders` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_resource_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `resource_run_mail_calls_run_idx` ON `resource_run_mail_calls` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `resource_run_mail_calls_stamp_idx` ON `resource_run_mail_calls` (`stamp`);--> statement-breakpoint
ALTER TABLE `trigger_resource_versions` ADD `connection_id` text;--> statement-breakpoint
ALTER TABLE `trigger_resource_versions` ADD `connection_resource` text;--> statement-breakpoint
ALTER TABLE `trigger_resource_versions` ADD `input_mapping` text;--> statement-breakpoint
CREATE INDEX `trigger_resource_versions_connection` ON `trigger_resource_versions` (`connection_id`,`event_type`) WHERE "trigger_resource_versions"."connection_id" IS NOT NULL;