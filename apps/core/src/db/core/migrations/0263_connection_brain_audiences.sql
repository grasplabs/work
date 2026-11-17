CREATE TABLE `connection_brain_audiences` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`team_id` text,
	`changed_by` text NOT NULL,
	`changed_at` integer NOT NULL
);
