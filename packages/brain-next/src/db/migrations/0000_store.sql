CREATE TABLE `reader_set_members` (
	`reader_set` integer NOT NULL,
	`kind` text NOT NULL,
	`principal` text NOT NULL,
	PRIMARY KEY(`reader_set`, `kind`, `principal`),
	FOREIGN KEY (`reader_set`) REFERENCES `reader_sets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reader_set_members_kind" CHECK("reader_set_members"."kind" IN ('person', 'group'))
);
--> statement-breakpoint
CREATE INDEX `reader_set_members_principal_idx` ON `reader_set_members` (`kind`,`principal`,`reader_set`);--> statement-breakpoint
CREATE TABLE `reader_sets` (
	`id` integer PRIMARY KEY NOT NULL,
	`key` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reader_sets_key_unique` ON `reader_sets` (`key`);--> statement-breakpoint
CREATE TABLE `sources` (
	`row` integer PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`reader_set` integer NOT NULL,
	`text` text NOT NULL,
	`added_at` integer NOT NULL,
	FOREIGN KEY (`reader_set`) REFERENCES `reader_sets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_id_unique` ON `sources` (`id`);--> statement-breakpoint
CREATE INDEX `sources_reader_set_idx` ON `sources` (`reader_set`);