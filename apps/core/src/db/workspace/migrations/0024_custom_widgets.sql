CREATE TABLE `custom_widgets` (
	`person_id` text NOT NULL,
	`id` text NOT NULL,
	`spec` text NOT NULL,
	`asked` text NOT NULL,
	`made_at` integer NOT NULL,
	`changed_at` integer NOT NULL,
	PRIMARY KEY(`person_id`, `id`)
);
