DROP TABLE `alerts`;--> statement-breakpoint
DROP TABLE `person_limits`;--> statement-breakpoint
DROP TABLE `request_scopes`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_spend` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`period` text NOT NULL,
	`spent_micros` integer DEFAULT 0 NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`scope`, `key`, `period`),
	CONSTRAINT "spend_spent" CHECK("__new_spend"."spent_micros" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_spend`("scope", "key", "period", "spent_micros", "requests") SELECT "scope", "key", "period", "spent_micros", "requests" FROM `spend`;--> statement-breakpoint
DROP TABLE `spend`;--> statement-breakpoint
ALTER TABLE `__new_spend` RENAME TO `spend`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `spend_top` ON `spend` (`scope`,`period`,`spent_micros`,`key`);--> statement-breakpoint
DELETE FROM `spend` WHERE `scope` IN ('person', 'binding_day');