ALTER TABLE `erasures` ADD `change` text;--> statement-breakpoint
CREATE INDEX `erasures_writer_idx` ON `erasures` (`subject`,`erased_at`) WHERE kind = 'writer';