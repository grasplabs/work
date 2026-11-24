-- The business process an App or a workflow serves (GRA-511): a column of
-- an App's, and a table of workflows' own.
CREATE TABLE `workflow_resource_processes` (
	`workflow_resource_id` text PRIMARY KEY NOT NULL,
	`process` text NOT NULL,
	`set_by` text NOT NULL,
	`set_at` integer NOT NULL,
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `apps` ADD `process` text;