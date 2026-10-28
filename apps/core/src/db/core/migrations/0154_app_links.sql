ALTER TABLE `apps` ADD `link` text;--> statement-breakpoint
CREATE UNIQUE INDEX `apps_link` ON `apps` (`link`);