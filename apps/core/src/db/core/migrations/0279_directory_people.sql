CREATE TABLE `directory_people` (
	`provider` text NOT NULL,
	`tenant` text NOT NULL,
	`account_id` text NOT NULL,
	`department` text NOT NULL,
	`enabled` integer NOT NULL,
	`user_id` text,
	PRIMARY KEY(`provider`, `tenant`, `account_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `directory_people_user_id_idx` ON `directory_people` (`user_id`);--> statement-breakpoint
CREATE TABLE `directory_reads` (
	`provider` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`tenant` text NOT NULL,
	`run` text,
	`started_at` integer,
	`read_at` integer,
	`people` integer,
	`disabled` integer,
	`failure` text,
	`failed_at` integer
);
--> statement-breakpoint
CREATE INDEX `accounts_provider_oid_lower_idx` ON `accounts` (`provider_id`,lower("oid"));