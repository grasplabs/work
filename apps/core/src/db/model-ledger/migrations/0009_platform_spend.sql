ALTER TABLE `request_scopes` ADD `reserved_micros` integer;--> statement-breakpoint
CREATE INDEX `requests_credential_period` ON `requests` (`credential`,`period`);