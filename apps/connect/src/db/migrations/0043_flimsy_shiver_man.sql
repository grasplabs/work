CREATE TABLE `connector_blocked_tools` (
	`connector_id` text NOT NULL,
	`name` text NOT NULL,
	`blocked_by` text NOT NULL,
	`blocked_at` integer NOT NULL,
	PRIMARY KEY(`connector_id`, `name`),
	FOREIGN KEY (`connector_id`) REFERENCES `connectors`(`id`) ON UPDATE no action ON DELETE no action
);
