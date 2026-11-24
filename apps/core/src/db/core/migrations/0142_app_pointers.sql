CREATE TABLE `app_pointers` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`resources` text DEFAULT '[]' NOT NULL,
	`who` text NOT NULL,
	`teams` text DEFAULT '[]' NOT NULL,
	`changed_by` text NOT NULL,
	`changed_at` integer NOT NULL
);
