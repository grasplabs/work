CREATE TABLE `staff_alerts` (
	`client_id` text NOT NULL,
	`kind` text NOT NULL,
	`sent_at` integer NOT NULL,
	PRIMARY KEY(`client_id`, `kind`)
);
