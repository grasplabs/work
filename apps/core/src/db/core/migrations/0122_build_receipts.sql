CREATE TABLE `build_receipts` (
	`key` text PRIMARY KEY NOT NULL,
	`object_key` text,
	`sha256` text,
	`bytes` integer,
	`built_at` integer,
	`holder` text,
	`lease_expires_at` integer,
	`integrity_failures` integer DEFAULT 0 NOT NULL,
	`failed_built_at` integer,
	`quarantined_at` integer
);
