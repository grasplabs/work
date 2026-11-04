CREATE TABLE `workflow_state` (
	`workflow_resource_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`run_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workflow_resource_id`, `key`),
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workflow_state_writes` (
	`step_key` text PRIMARY KEY NOT NULL,
	`workflow_resource_id` text NOT NULL,
	`run_id` text NOT NULL,
	`write_id` text NOT NULL,
	`bytes` integer NOT NULL,
	`written_at` integer NOT NULL,
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_state_writes_workflow_idx` ON `workflow_state_writes` (`workflow_resource_id`);