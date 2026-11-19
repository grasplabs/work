CREATE TABLE `retired_team_ids` (
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `staff_list_placed` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`placed` integer NOT NULL,
	`lease_id` text,
	`lease_until` integer
);
--> statement-breakpoint
CREATE TABLE `team_primaries` (
	`user_id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`placed_at` integer NOT NULL,
	`made` integer NOT NULL,
	`place_key` text NOT NULL,
	`pending` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `team_primaries_team_id_idx` ON `team_primaries` (`team_id`);
--> statement-breakpoint
-- Every deleted team's id is retired in the statement that deletes it
-- (GRA-2055): the staff list never makes a team again under a retired id,
-- so a deleted team's id never comes back with what was shared with it,
-- whichever release's code deleted it.
CREATE TRIGGER `teams_delete_retires` AFTER DELETE ON `teams` BEGIN
	INSERT OR IGNORE INTO `retired_team_ids` (`id`) VALUES (OLD.`id`);
END;
