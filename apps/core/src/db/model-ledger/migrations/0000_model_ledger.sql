CREATE TABLE `alerts` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`period` text NOT NULL,
	`kind` text NOT NULL,
	`threshold_micros` integer NOT NULL,
	PRIMARY KEY(`scope`, `key`, `period`, `kind`, `threshold_micros`)
);
--> statement-breakpoint
CREATE TABLE `audit_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `request_scopes` (
	`request_id` text NOT NULL,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`limit_micros` integer,
	`alert_micros` integer,
	`names` text DEFAULT '{}' NOT NULL,
	PRIMARY KEY(`request_id`, `scope`, `key`)
);
--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`period` text NOT NULL,
	`scopes` text NOT NULL,
	`model` text NOT NULL,
	`price_version` text NOT NULL,
	`prices` text NOT NULL,
	`reserved_micros` integer NOT NULL,
	`charged_micros` integer,
	`state` text NOT NULL,
	`settled_by` text,
	`actor` text NOT NULL,
	`dispatched_at` integer NOT NULL,
	`reconcile_at` integer NOT NULL,
	`reconcile_failures` integer DEFAULT 0 NOT NULL,
	`settled_at` integer,
	CONSTRAINT "requests_reserved" CHECK("requests"."reserved_micros" >= 0),
	CONSTRAINT "requests_settled" CHECK(("requests"."state" = 'settled') = ("requests"."charged_micros" IS NOT NULL AND "requests"."charged_micros" >= 0 AND "requests"."settled_by" IS NOT NULL AND "requests"."settled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `requests_open` ON `requests` (`state`,`reconcile_at`);--> statement-breakpoint
CREATE INDEX `requests_settled_at` ON `requests` (`settled_at`);--> statement-breakpoint
CREATE TABLE `spend` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`period` text NOT NULL,
	`reserved_micros` integer DEFAULT 0 NOT NULL,
	`spent_micros` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`scope`, `key`, `period`),
	CONSTRAINT "spend_reserved" CHECK("spend"."reserved_micros" >= 0),
	CONSTRAINT "spend_spent" CHECK("spend"."spent_micros" >= 0)
);
--> statement-breakpoint
CREATE INDEX `spend_top` ON `spend` (`scope`,`period`,`spent_micros`,`key`);