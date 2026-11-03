CREATE TABLE `http_connections` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`origin` text NOT NULL,
	`path_prefixes` text NOT NULL,
	`methods` text NOT NULL,
	`credential_header` text NOT NULL,
	`credential_kind` text NOT NULL,
	`sealed` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action
);
