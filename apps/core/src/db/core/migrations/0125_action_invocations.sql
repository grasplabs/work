CREATE TABLE `action_invocations` (
	`name` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`app_id` text NOT NULL,
	`streaming` integer NOT NULL,
	`created_at` integer NOT NULL
);
