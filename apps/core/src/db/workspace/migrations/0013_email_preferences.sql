CREATE TABLE `email_preferences` (
	`person_id` text PRIMARY KEY NOT NULL,
	`needs_you` integer NOT NULL,
	`weekly_summary` integer NOT NULL,
	`billing_problems` integer NOT NULL,
	`updated_at` integer NOT NULL
);
