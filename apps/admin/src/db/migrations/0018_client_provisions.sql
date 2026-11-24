CREATE TABLE `client_provisions` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`release_id` text NOT NULL,
	`status` text NOT NULL,
	`step` text,
	`error` text,
	`progress` text,
	`run_id` text,
	`started_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `client_provisions_client_id_unique` ON `client_provisions` (`client_id`);