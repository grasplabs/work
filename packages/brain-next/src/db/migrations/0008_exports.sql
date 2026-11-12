CREATE TABLE `export_parts` (
	`export` text NOT NULL,
	`part` integer NOT NULL,
	`hash` text NOT NULL,
	`versions` integer NOT NULL,
	PRIMARY KEY(`export`, `part`),
	FOREIGN KEY (`export`) REFERENCES `exports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `exports` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`subject` text,
	`reader_set` integer,
	`up_to` integer NOT NULL,
	`cursor` integer NOT NULL,
	`erasure_mark` integer NOT NULL,
	`state` text NOT NULL,
	`parts` integer NOT NULL,
	`versions` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	CONSTRAINT "exports_scope" CHECK("exports"."scope" IN ('company', 'person'))
);
--> statement-breakpoint
CREATE INDEX `exports_state_idx` ON `exports` (`state`,`erasure_mark`);--> statement-breakpoint
CREATE TABLE `restores` (
	`export` text PRIMARY KEY NOT NULL,
	`manifest` text NOT NULL,
	`part` integer NOT NULL,
	`restored` integer NOT NULL,
	`state` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
