ALTER TABLE `erasures` ADD `memories` integer;--> statement-breakpoint
ALTER TABLE `memories` ADD `writer_subject` text;--> statement-breakpoint
ALTER TABLE `memories` ADD `retired_change` text;--> statement-breakpoint
CREATE INDEX `memories_writer_idx` ON `memories` (`writer_subject`,`learned_at`);