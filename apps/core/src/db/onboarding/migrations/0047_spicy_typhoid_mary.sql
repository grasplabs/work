CREATE TABLE `erased_addresses` (
	`hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`released` integer DEFAULT false NOT NULL
);
