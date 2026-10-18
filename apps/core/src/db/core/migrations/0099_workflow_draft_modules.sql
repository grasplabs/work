CREATE TABLE `workflow_resource_draft_modules` (
	`workflow_resource_id` text NOT NULL,
	`revision` integer NOT NULL,
	`path` text NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`workflow_resource_id`, `revision`, `path`),
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
