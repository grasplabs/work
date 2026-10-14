CREATE TABLE `workflow_owners` (
	`app_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`set_by` text NOT NULL,
	`set_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `workflow_id`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
