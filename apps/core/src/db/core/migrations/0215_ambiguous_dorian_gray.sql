ALTER TABLE `dependency_requests` ADD `scanned_at` integer;--> statement-breakpoint
CREATE INDEX `dependency_requests_scan_idx` ON `dependency_requests` (`scanned_at`,`status`);