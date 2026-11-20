ALTER TABLE `brain_uploads` ADD `removed_at` integer;--> statement-breakpoint
ALTER TABLE `brain_uploads` ADD `removal_owed` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `brain_uploads_removal_owed_idx` ON `brain_uploads` (`removed_at`) WHERE removal_owed = 1;