CREATE TABLE `queue` (
	`place` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`resource` text NOT NULL,
	`turn` integer NOT NULL,
	`enqueued_at` integer NOT NULL,
	`seen_at` integer NOT NULL,
	`waiting_for` text NOT NULL,
	`retry_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `queue_order` ON `queue` (`turn`,`enqueued_at`,`place`);--> statement-breakpoint
CREATE INDEX `queue_seen` ON `queue` (`seen_at`);--> statement-breakpoint
CREATE INDEX `queue_subject` ON `queue` (`subject`,`resource`,`seen_at`);--> statement-breakpoint
CREATE INDEX `queue_resource` ON `queue` (`resource`,`seen_at`);--> statement-breakpoint
ALTER TABLE `requests` ADD `subject` text;--> statement-breakpoint
ALTER TABLE `requests` ADD `resource` text;--> statement-breakpoint
ALTER TABLE `requests` ADD `lease_ends_at` integer;--> statement-breakpoint
CREATE INDEX `requests_leases` ON `requests` (`state`,`lease_ends_at`);