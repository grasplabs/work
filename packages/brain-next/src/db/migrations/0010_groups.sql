CREATE TABLE `known_groups` (
	`subject` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE `source_subjects` ADD `group_subject` text;--> statement-breakpoint
CREATE INDEX `source_subjects_group_idx` ON `source_subjects` (`group_subject`);