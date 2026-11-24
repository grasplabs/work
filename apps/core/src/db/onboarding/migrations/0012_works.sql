CREATE TABLE `asked_about` (
	`person` text PRIMARY KEY NOT NULL,
	`work` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `draw_failures` (
	`item` text PRIMARY KEY NOT NULL,
	`tries` integer NOT NULL,
	`after` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `works` (
	`id` text PRIMARY KEY NOT NULL,
	`team` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`local` text NOT NULL,
	`one` text NOT NULL,
	`many` text NOT NULL,
	`doers` text NOT NULL,
	`share` real NOT NULL
);
