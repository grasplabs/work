CREATE TABLE `staff_list_placed` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `staff_list_team_ids` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `team_primaries` (
	`user_id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`placed_at` integer NOT NULL,
	`made` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `team_primaries_team_id_idx` ON `team_primaries` (`team_id`);