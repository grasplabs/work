CREATE TABLE `entries` (
	`generation` text NOT NULL,
	`id` text NOT NULL,
	`policy` text NOT NULL,
	`shard` integer NOT NULL,
	`seq` integer NOT NULL,
	`version` text,
	`pending` integer NOT NULL,
	PRIMARY KEY(`generation`, `id`)
);
--> statement-breakpoint
CREATE INDEX `entries_shard` ON `entries` (`generation`,`policy`,`shard`);--> statement-breakpoint
CREATE TABLE `generations` (
	`id` text PRIMARY KEY NOT NULL,
	`spec` text NOT NULL,
	`state` text NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `moving` (
	`generation` text NOT NULL,
	`id` text NOT NULL,
	`policy` text NOT NULL,
	`shard` integer NOT NULL,
	PRIMARY KEY(`generation`, `id`, `policy`, `shard`)
);
