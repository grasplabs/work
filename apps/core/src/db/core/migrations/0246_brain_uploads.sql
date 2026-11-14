CREATE TABLE `brain_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`uploaded_by` text NOT NULL,
	`name` text NOT NULL,
	`readers` text NOT NULL,
	`team_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
