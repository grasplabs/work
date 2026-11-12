CREATE TABLE `export_parts` (
	`export` text NOT NULL,
	`part` integer NOT NULL,
	`hash` text NOT NULL,
	`versions` integer NOT NULL,
	`bytes` integer NOT NULL,
	PRIMARY KEY(`export`, `part`),
	FOREIGN KEY (`export`) REFERENCES `exports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `export_sources` (
	`export` text NOT NULL,
	`subject` text NOT NULL,
	`version` integer NOT NULL,
	PRIMARY KEY(`export`, `subject`, `version`),
	FOREIGN KEY (`export`) REFERENCES `exports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `export_sources_subject_idx` ON `export_sources` (`subject`,`version`);--> statement-breakpoint
CREATE TABLE `export_sweep` (
	`id` integer PRIMARY KEY NOT NULL,
	`through` integer NOT NULL,
	`checked` integer DEFAULT 0 NOT NULL,
	`cursor` text,
	CONSTRAINT "export_sweep_one" CHECK(id = 1)
);
--> statement-breakpoint
CREATE TABLE `exports` (
	`id` text PRIMARY KEY NOT NULL,
	`deployment` text NOT NULL,
	`up_to` integer NOT NULL,
	`cursor` integer NOT NULL,
	`state` text NOT NULL,
	`parts` integer NOT NULL,
	`versions` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `exports_state_idx` ON `exports` (`state`,`finished_at`);--> statement-breakpoint
CREATE TABLE `restores` (
	`export` text PRIMARY KEY NOT NULL,
	`manifest` text NOT NULL,
	`checked` integer NOT NULL,
	`damaged` integer DEFAULT false NOT NULL,
	`held_to` integer,
	`part` integer NOT NULL,
	`restored` integer NOT NULL,
	`state` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
