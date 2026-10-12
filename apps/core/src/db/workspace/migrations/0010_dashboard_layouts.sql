CREATE TABLE `dashboard_widgets` (
	`person_id` text NOT NULL,
	`position` integer NOT NULL,
	`widget_id` text NOT NULL,
	PRIMARY KEY(`person_id`, `position`),
	FOREIGN KEY (`person_id`) REFERENCES `dashboards`(`person_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dashboards` (
	`person_id` text PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL
);
