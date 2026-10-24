CREATE TABLE `app_tool_classes` (
	`app` text NOT NULL,
	`tool_class` text NOT NULL,
	`who` text NOT NULL,
	`teams` text DEFAULT '[]' NOT NULL,
	`changed_by` text NOT NULL,
	`changed_at` integer NOT NULL,
	PRIMARY KEY(`app`, `tool_class`)
);
--> statement-breakpoint
CREATE TABLE `stephen_places` (
	`place` text PRIMARY KEY NOT NULL,
	`who` text NOT NULL,
	`teams` text DEFAULT '[]' NOT NULL,
	`acts` integer NOT NULL,
	`changed_by` text NOT NULL,
	`changed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stephen_reach` (
	`id` text PRIMARY KEY NOT NULL,
	`on` integer NOT NULL,
	`who` text NOT NULL,
	`teams` text DEFAULT '[]' NOT NULL,
	`changed_by` text NOT NULL,
	`changed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tool_class_settings` (
	`tool_class` text PRIMARY KEY NOT NULL,
	`who` text NOT NULL,
	`teams` text DEFAULT '[]' NOT NULL,
	`changed_by` text NOT NULL,
	`changed_at` integer NOT NULL
);
