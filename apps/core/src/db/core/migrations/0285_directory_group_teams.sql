CREATE TABLE `directory_group_teams` (
	`provider` text NOT NULL,
	`group_id` text NOT NULL,
	`team_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`members_from` text NOT NULL,
	`mapped_at` integer NOT NULL,
	`read_at` integer,
	PRIMARY KEY(`provider`, `group_id`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `directory_group_teams_team_id_idx` ON `directory_group_teams` (`team_id`);