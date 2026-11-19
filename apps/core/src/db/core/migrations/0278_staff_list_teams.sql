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
--> statement-breakpoint
-- The Brain names a staff-list team by the members' team's own id now
-- (GRA-2055), where it named it `team-<id>` before: the regions, and every
-- kept set of them (which the arrangement reads to never place a team
-- twice), are rewritten here once to name it so too. Id by id, as whole
-- JSON string values in order, never a region's name; only an id starting
-- `team-` is a staff-list team's (a kickoff's is `onb-`, and a team record
-- under `team-` was refused).
UPDATE `brain_team_groups` SET `team_ids` = (
	SELECT json_group_array(
		CASE WHEN substr(`team`.`value`, 1, 5) = 'team-' THEN substr(`team`.`value`, 6) ELSE `team`.`value` END
		ORDER BY `team`.`key`
	)
	FROM json_each(`brain_team_groups`.`team_ids`) AS `team`
);
--> statement-breakpoint
UPDATE `brain_team_group_saves` SET
	`before` = (
		SELECT json_group_array(
			json_set(`region`.`value`, '$.teamIds', json((
				SELECT json_group_array(
					CASE WHEN substr(`team`.`value`, 1, 5) = 'team-' THEN substr(`team`.`value`, 6) ELSE `team`.`value` END
					ORDER BY `team`.`key`
				)
				FROM json_each(`region`.`value`, '$.teamIds') AS `team`
			)))
			ORDER BY `region`.`key`
		)
		FROM json_each(`brain_team_group_saves`.`before`) AS `region`
	),
	`after` = (
		SELECT json_group_array(
			json_set(`region`.`value`, '$.teamIds', json((
				SELECT json_group_array(
					CASE WHEN substr(`team`.`value`, 1, 5) = 'team-' THEN substr(`team`.`value`, 6) ELSE `team`.`value` END
					ORDER BY `team`.`key`
				)
				FROM json_each(`region`.`value`, '$.teamIds') AS `team`
			)))
			ORDER BY `region`.`key`
		)
		FROM json_each(`brain_team_group_saves`.`after`) AS `region`
	);
