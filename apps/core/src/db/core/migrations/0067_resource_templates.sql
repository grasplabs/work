CREATE TABLE `resource_templates` (
	`id` text NOT NULL,
	`version` integer NOT NULL,
	`contract` text NOT NULL,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`published_by` text NOT NULL,
	`published_at` integer NOT NULL,
	PRIMARY KEY(`id`, `version`)
);
