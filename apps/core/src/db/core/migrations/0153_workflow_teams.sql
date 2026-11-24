CREATE TABLE `workflow_teams` (
	`app_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`team_id` text NOT NULL,
	`set_by` text NOT NULL,
	`set_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `workflow_id`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_teams_team` ON `workflow_teams` (`team_id`);