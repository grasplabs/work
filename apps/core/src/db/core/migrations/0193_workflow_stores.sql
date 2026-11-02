CREATE TABLE `workflow_stores` (
	`workflow_id` text NOT NULL,
	`name` text NOT NULL,
	`store_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`workflow_id`, `name`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_stores_store_id_unique` ON `workflow_stores` (`store_id`);