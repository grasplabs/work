CREATE TABLE `sync_picks` (
	`connection_id` text NOT NULL,
	`feed` text NOT NULL,
	`place` text NOT NULL,
	`picked_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `feed`, `place`),
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action
);
