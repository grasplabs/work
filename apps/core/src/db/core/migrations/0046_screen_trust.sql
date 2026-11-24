CREATE TABLE `screen_artifacts` (
	`app_id` text NOT NULL,
	`artifact` text NOT NULL,
	`version` integer NOT NULL,
	`screen` text NOT NULL,
	`status` text NOT NULL,
	`decided_by` text NOT NULL,
	`decided_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `artifact`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `screen_builds` (
	`app_id` text NOT NULL,
	`version` integer NOT NULL,
	`release` text NOT NULL,
	`screen` text NOT NULL,
	`artifact` text NOT NULL,
	PRIMARY KEY(`app_id`, `version`, `release`, `screen`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `screen_policies` (
	`app_id` text PRIMARY KEY NOT NULL,
	`output` text NOT NULL,
	`generation` integer NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
