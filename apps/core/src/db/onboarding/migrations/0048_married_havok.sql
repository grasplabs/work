CREATE TABLE `left_addresses` (
	`user_id` text NOT NULL,
	`hash` text NOT NULL,
	PRIMARY KEY(`user_id`, `hash`)
);
