ALTER TABLE `events` ADD `system` text;--> statement-breakpoint
ALTER TABLE `events` ADD `writes` integer;--> statement-breakpoint
CREATE INDEX `events_trail_idx` ON `events` (`team`,`who`,`at`,`row`);