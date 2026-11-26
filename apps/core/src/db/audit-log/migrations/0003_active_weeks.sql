CREATE TABLE `active_weeks` (
	`week` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`week`, `user_id`)
);
