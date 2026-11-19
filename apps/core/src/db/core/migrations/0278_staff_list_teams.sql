CREATE TABLE `retired_team_ids` (
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `staff_list_synced` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL
);
--> statement-breakpoint
-- Every deleted team's id is retired in the statement that deletes it
-- (GRA-2055): the staff list never makes a team again under a retired id,
-- so a deleted team's id never comes back with what was shared with it,
-- whichever release's code deleted it.
CREATE TRIGGER `teams_delete_retires` AFTER DELETE ON `teams` BEGIN
	INSERT OR IGNORE INTO `retired_team_ids` (`id`) VALUES (OLD.`id`);
END;
