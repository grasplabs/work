CREATE TABLE `sdk_schema_backfills` (
	`target_hash` text PRIMARY KEY NOT NULL,
	`target_manifest` text NOT NULL,
	`base_hash` text,
	`fills` text NOT NULL,
	`scan_bounds` text NOT NULL,
	`state` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`lease_until` integer,
	`looked_at` integer,
	`stalls` integer DEFAULT 0 NOT NULL,
	`stall_scanned` integer,
	`last_batch` integer DEFAULT 0 NOT NULL,
	`last_outcome` text,
	`cursor_table` text,
	`cursor_record` text,
	`scanned` integer DEFAULT 0 NOT NULL,
	`filled` integer DEFAULT 0 NOT NULL,
	`failure` text,
	`failure_revision` integer,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	CONSTRAINT "sdk_schema_backfills_attempt" CHECK("sdk_schema_backfills"."attempt" >= 1),
	CONSTRAINT "sdk_schema_backfills_failure" CHECK(("sdk_schema_backfills"."state" = 'failed') = ("sdk_schema_backfills"."failure" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sdk_schema_backfills_pending` ON `sdk_schema_backfills` (`state`) WHERE state <> 'complete';