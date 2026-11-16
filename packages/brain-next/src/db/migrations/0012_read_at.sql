ALTER TABLE `source_changes` ADD `read_at` integer;--> statement-breakpoint
CREATE INDEX `source_changes_version_idx` ON `source_changes` (`version_row`,`read_at`);