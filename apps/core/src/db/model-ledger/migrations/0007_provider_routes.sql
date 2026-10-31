CREATE TABLE `provider_health` (
	`provider` text NOT NULL,
	`credential` text NOT NULL,
	`last_ok_at` integer,
	`last_failed_at` integer,
	`last_failure` text,
	`last_status` integer,
	PRIMARY KEY(`provider`, `credential`)
);
--> statement-breakpoint
ALTER TABLE `requests` ADD `transport` text;--> statement-breakpoint
ALTER TABLE `requests` ADD `provider` text;--> statement-breakpoint
ALTER TABLE `requests` ADD `region` text;--> statement-breakpoint
ALTER TABLE `requests` ADD `credential` text;