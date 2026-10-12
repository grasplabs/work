ALTER TABLE `request_scopes` ADD `period` text;--> statement-breakpoint
ALTER TABLE `request_scopes` ADD `limit_requests` integer;--> statement-breakpoint
ALTER TABLE `spend` ADD `requests` integer DEFAULT 0 NOT NULL;