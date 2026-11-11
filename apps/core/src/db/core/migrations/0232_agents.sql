CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`face` text NOT NULL,
	`job` text NOT NULL,
	`instructions` text NOT NULL,
	`model_role` text,
	`state` text NOT NULL,
	`made_by` text NOT NULL,
	`made_at` integer NOT NULL,
	`changed_by` text NOT NULL,
	`changed_at` integer NOT NULL
);
