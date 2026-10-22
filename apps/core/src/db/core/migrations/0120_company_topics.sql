ALTER TABLE `admission_topics` ADD `terms` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `admission_topics` ADD `retired` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `admission_topics` ADD `created_by` text;