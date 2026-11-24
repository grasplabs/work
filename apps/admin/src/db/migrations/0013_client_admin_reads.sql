CREATE TABLE `client_admin_reads` (
	`client_id` text PRIMARY KEY NOT NULL,
	`last_answered_at` integer,
	`error` text,
	`asked_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
