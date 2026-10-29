CREATE TABLE `app_visitor_grants` (
	`app_id` text NOT NULL,
	`version` integer NOT NULL,
	`function` text NOT NULL,
	`granted_by` text NOT NULL,
	`granted_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `version`, `function`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
