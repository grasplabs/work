DROP INDEX `dependency_requests_malware_idx`;--> statement-breakpoint
ALTER TABLE `dependency_requests` DROP COLUMN `malware_checked_at`;