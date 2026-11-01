PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_request_scopes` (
	`request_id` text NOT NULL,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`limit_micros` integer,
	`alert_micros` integer,
	`names` text DEFAULT '{}' NOT NULL,
	`period` text NOT NULL,
	`limit_requests` integer,
	`reserved_micros` integer NOT NULL,
	PRIMARY KEY(`request_id`, `scope`, `key`)
);
--> statement-breakpoint
INSERT INTO `__new_request_scopes`("request_id", "scope", "key", "limit_micros", "alert_micros", "names", "period", "limit_requests", "reserved_micros") SELECT s."request_id", s."scope", s."key", s."limit_micros", s."alert_micros", s."names", coalesce(s."period", r."period"), s."limit_requests", coalesce(s."reserved_micros", r."reserved_micros") FROM `request_scopes` s JOIN `requests` r ON r."id" = s."request_id";--> statement-breakpoint
DROP TABLE `request_scopes`;--> statement-breakpoint
ALTER TABLE `__new_request_scopes` RENAME TO `request_scopes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `request_scopes_scope_key` ON `request_scopes` (`scope`,`key`);