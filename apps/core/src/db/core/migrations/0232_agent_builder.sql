CREATE TABLE `agent_places` (
	`agent_id` text NOT NULL,
	`place` text NOT NULL,
	`who` text NOT NULL,
	`teams` text DEFAULT '[]' NOT NULL,
	`acts` integer NOT NULL,
	`changed_by` text NOT NULL,
	`changed_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `place`)
);
--> statement-breakpoint
CREATE TABLE `agent_reach` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`on` integer NOT NULL,
	`who` text NOT NULL,
	`teams` text DEFAULT '[]' NOT NULL,
	`changed_by` text NOT NULL,
	`changed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_tool_classes` (
	`agent_id` text NOT NULL,
	`tool_class` text NOT NULL,
	`who` text NOT NULL,
	`teams` text DEFAULT '[]' NOT NULL,
	`changed_by` text NOT NULL,
	`changed_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `tool_class`)
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text,
	`face` text NOT NULL,
	`job` text NOT NULL,
	`instructions` text NOT NULL,
	`model_role` text,
	`state` text NOT NULL,
	`made_by` text NOT NULL,
	`made_at` integer NOT NULL,
	`changed_by` text NOT NULL,
	`changed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_name_key_idx` ON `agents` (`name_key`);