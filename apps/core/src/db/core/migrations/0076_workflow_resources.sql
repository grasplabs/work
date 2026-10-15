CREATE TABLE `workflow_resource_members` (
	`workflow_resource_id` text NOT NULL,
	`member_type` text NOT NULL,
	`member_id` text NOT NULL,
	`role` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`workflow_resource_id`, `member_type`, `member_id`),
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_resource_members_member_idx` ON `workflow_resource_members` (`member_type`,`member_id`);--> statement-breakpoint
CREATE TABLE `workflow_resource_versions` (
	`workflow_resource_id` text NOT NULL,
	`version` integer NOT NULL,
	`definition_version` text NOT NULL,
	`definition` text NOT NULL,
	`definition_json_hash` text NOT NULL,
	`profile_version` text NOT NULL,
	`evaluator_hash` text NOT NULL,
	`contract` text NOT NULL,
	`contract_hash` text NOT NULL,
	`manifest` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`author_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`workflow_resource_id`, `version`),
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_resource_versions_definition_version` ON `workflow_resource_versions` (`workflow_resource_id`,`definition_version`);--> statement-breakpoint
CREATE TABLE `workflow_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_id` text NOT NULL,
	`current_version` integer,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_resources_name_unique` ON `workflow_resources` (`name`);--> statement-breakpoint
ALTER TABLE `sdk_resource_bindings` ADD `contract_id` text;