CREATE TABLE `trigger_resource_versions` (
	`trigger_id` text NOT NULL,
	`version` integer NOT NULL,
	`workflow_resource_id` text NOT NULL,
	`workflow_resource_version` integer NOT NULL,
	`config_hash` text NOT NULL,
	`principal_binding` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`trigger_id`, `version`),
	FOREIGN KEY (`trigger_id`) REFERENCES `trigger_resources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `trigger_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`current_version` integer NOT NULL,
	`enabled` integer NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `workflow_start_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`invoker_type` text NOT NULL,
	`invoker_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`workflow_resource_id` text NOT NULL,
	`workflow_resource_version` integer NOT NULL,
	`manifest_hash` text NOT NULL,
	`origin_app_version` integer,
	`trigger_version` integer,
	`principal_id` text NOT NULL,
	`authority_generation` integer NOT NULL,
	`input` text NOT NULL,
	`input_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_start_receipts_key` ON `workflow_start_receipts` (`invoker_type`,`invoker_id`,`principal_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `workflow_start_receipts_workflow` ON `workflow_start_receipts` (`workflow_resource_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `workflow_resources` ADD `policy_generation` integer DEFAULT 1 NOT NULL;