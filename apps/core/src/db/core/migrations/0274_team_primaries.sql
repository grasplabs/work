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