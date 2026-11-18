ALTER TABLE `connections` ADD `reader_groups` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `reader_groups_at` integer;--> statement-breakpoint
ALTER TABLE `connections` ADD `reader_groups_tried_at` integer;--> statement-breakpoint
ALTER TABLE `connections` ADD `reader_groups_reading` text;