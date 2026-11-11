CREATE TABLE `client_model_files` (
	`client_id` text NOT NULL,
	`sha256` text NOT NULL,
	`copied_at` integer NOT NULL,
	PRIMARY KEY(`client_id`, `sha256`),
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
