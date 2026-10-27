CREATE TABLE `policy_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`file_name` text NOT NULL,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`uploaded_by` text NOT NULL,
	`uploaded_at` integer NOT NULL,
	`published_at` integer
);
--> statement-breakpoint
CREATE TABLE `policy_exceptions` (
	`rule_id` text NOT NULL,
	`app_id` text NOT NULL,
	`reason` text NOT NULL,
	`until` text NOT NULL,
	`granted_by` text NOT NULL,
	`granted_at` integer NOT NULL,
	PRIMARY KEY(`rule_id`, `app_id`)
);
--> statement-breakpoint
CREATE TABLE `policy_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`conditions` text NOT NULL,
	`effect` text NOT NULL,
	`status` text NOT NULL,
	`policy_id` text,
	`excerpt` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `policy_rules_policy_idx` ON `policy_rules` (`policy_id`);