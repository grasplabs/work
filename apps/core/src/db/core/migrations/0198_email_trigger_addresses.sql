ALTER TABLE `trigger_resources` ADD `email_address` text;--> statement-breakpoint
CREATE UNIQUE INDEX `trigger_resources_email_address_unique` ON `trigger_resources` (`email_address`);