CREATE TABLE `dependency_locks` (
	`app_id` text NOT NULL,
	`graph_hash` text NOT NULL,
	`lock` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `graph_hash`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
