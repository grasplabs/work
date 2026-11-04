ALTER TABLE `dependency_requests` ADD `scanned_at` integer;--> statement-breakpoint
ALTER TABLE `dependency_requests` ADD `advisories_noticed` text;--> statement-breakpoint
CREATE INDEX `dependency_requests_requested_idx` ON `dependency_requests` (`requested_by`,`status`);--> statement-breakpoint
CREATE INDEX `dependency_requests_scan_idx` ON `dependency_requests` (`scanned_at`,`status`);