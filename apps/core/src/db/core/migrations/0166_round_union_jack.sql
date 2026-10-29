CREATE TABLE `brain_team_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`team_ids` text NOT NULL,
	`position` integer NOT NULL,
	`confirmed_at` integer,
	`saved_at` integer NOT NULL
);
