CREATE TABLE `client_watch` (
	`client_id` text PRIMARY KEY NOT NULL,
	`read_at` integer NOT NULL,
	`signals` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
