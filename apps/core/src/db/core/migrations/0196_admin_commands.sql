CREATE TABLE `admin_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`claimed_at` integer NOT NULL,
	`applied_at` integer
);
