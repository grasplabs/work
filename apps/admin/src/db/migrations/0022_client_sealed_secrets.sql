CREATE TABLE `client_sealed_secrets` (
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`sealed` text NOT NULL,
	`set_by` text NOT NULL,
	`set_at` integer NOT NULL,
	PRIMARY KEY(`client_id`, `name`),
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
