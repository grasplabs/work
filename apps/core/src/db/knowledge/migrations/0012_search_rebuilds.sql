CREATE TABLE `search_rebuilds` (
	`id` text PRIMARY KEY NOT NULL,
	`owed_at` integer NOT NULL,
	`writes_done_at` integer
);
