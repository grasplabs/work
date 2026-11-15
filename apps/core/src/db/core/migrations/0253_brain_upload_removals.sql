ALTER TABLE `brain_uploads` ADD `removed_at` integer;--> statement-breakpoint
ALTER TABLE `brain_uploads` ADD `removal_owed` integer DEFAULT false NOT NULL;