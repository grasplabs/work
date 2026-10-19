CREATE TABLE `workflow_resource_drafts` (
	`workflow_resource_id` text NOT NULL,
	`revision` integer NOT NULL,
	`source` text NOT NULL,
	`checked` integer NOT NULL,
	`problems` text NOT NULL,
	`edited_by` text NOT NULL,
	`edited_at` integer NOT NULL,
	PRIMARY KEY(`workflow_resource_id`, `revision`),
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
