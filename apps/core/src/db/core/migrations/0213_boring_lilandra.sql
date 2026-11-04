DROP TABLE `dependency_approvers`;--> statement-breakpoint
ALTER TABLE `dependency_requests` ADD `advisories_noticed` text;--> statement-breakpoint
CREATE INDEX `dependency_requests_requested_idx` ON `dependency_requests` (`requested_by`,`status`);