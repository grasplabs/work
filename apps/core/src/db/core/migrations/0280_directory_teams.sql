CREATE TABLE `directory_departments` (
	`provider` text NOT NULL,
	`department` text NOT NULL,
	`team_id` text NOT NULL,
	PRIMARY KEY(`provider`, `department`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `directory_departments_team_id_idx` ON `directory_departments` (`team_id`);--> statement-breakpoint
CREATE TABLE `directory_memberships` (
	`membership_key` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`membership_key`) REFERENCES `team_members`(`membership_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `team_pins` (
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kept` integer NOT NULL,
	`pinned_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `team_id`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `team_pins_team_id_idx` ON `team_pins` (`team_id`);