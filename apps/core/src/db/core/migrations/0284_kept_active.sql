ALTER TABLE `directory_people` ADD `deleted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `kept_active_at` integer;