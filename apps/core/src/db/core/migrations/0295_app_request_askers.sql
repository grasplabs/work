CREATE TABLE `app_request_askers` (
	`request_id` text NOT NULL,
	`user_id` text NOT NULL,
	`asked_at` integer NOT NULL,
	PRIMARY KEY(`request_id`, `user_id`)
);
