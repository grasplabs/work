CREATE TABLE `interview_teams` (
	`user_id` text PRIMARY KEY NOT NULL,
	`team` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
