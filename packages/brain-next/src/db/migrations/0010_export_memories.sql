ALTER TABLE `export_parts` ADD `memories` integer;--> statement-breakpoint
ALTER TABLE `export_sources` ADD `written` integer;--> statement-breakpoint
ALTER TABLE `exports` ADD `phase` integer;--> statement-breakpoint
ALTER TABLE `exports` ADD `stamp` integer;--> statement-breakpoint
ALTER TABLE `exports` ADD `changes_up_to` integer;--> statement-breakpoint
ALTER TABLE `restores` ADD `held_stamp` integer;