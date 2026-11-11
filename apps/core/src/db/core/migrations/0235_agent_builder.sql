ALTER TABLE `agents` ADD `name_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_name_key_idx` ON `agents` (`name_key`);