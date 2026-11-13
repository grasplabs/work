ALTER TABLE `source_subjects` ADD `group_subject` text;--> statement-breakpoint
CREATE INDEX `source_subjects_group_idx` ON `source_subjects` (`group_subject`);