CREATE TABLE `run_brain_versions` (
	`run_id` text NOT NULL,
	`producer` text NOT NULL,
	`source_id` text NOT NULL,
	`version` integer NOT NULL,
	`permission_id` text NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `producer`, `source_id`, `version`, `permission_id`)
);
