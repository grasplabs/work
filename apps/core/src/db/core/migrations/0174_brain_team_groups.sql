CREATE TABLE `brain_team_group_saves` (
	`id` text PRIMARY KEY NOT NULL,
	`saved_at` integer NOT NULL,
	`before` text NOT NULL,
	`after` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `brain_team_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`team_ids` text NOT NULL,
	`position` integer NOT NULL,
	`confirmed_at` integer,
	`saved_at` integer NOT NULL
);
