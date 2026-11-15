ALTER TABLE `erasures` ADD `swept_learned_at` integer;--> statement-breakpoint
ALTER TABLE `erasures` ADD `swept_row` integer;--> statement-breakpoint
CREATE INDEX `memory_erase_failures_order_idx` ON `memory_erase_failures` (`failures`,`memory`);