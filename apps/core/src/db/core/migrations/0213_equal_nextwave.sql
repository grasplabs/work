CREATE TABLE `dependency_request_askers` (
	`request_id` text NOT NULL,
	`person_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`workspace_id` text,
	`asked_at` integer NOT NULL,
	PRIMARY KEY(`request_id`, `person_id`, `chat_id`),
	FOREIGN KEY (`request_id`) REFERENCES `dependency_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dependency_request_askers_person_idx` ON `dependency_request_askers` (`person_id`,`chat_id`);--> statement-breakpoint
ALTER TABLE `dependency_requests` ADD `scanned_at` integer;--> statement-breakpoint
ALTER TABLE `dependency_requests` ADD `advisories_noticed` text;--> statement-breakpoint
CREATE INDEX `dependency_requests_scan_idx` ON `dependency_requests` (`scanned_at`,`status`);