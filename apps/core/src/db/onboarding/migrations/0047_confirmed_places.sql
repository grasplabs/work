CREATE TABLE `confirmed_places` (
	`person` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`entra_tenant` text,
	`entra_oid` text,
	`team` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `erased_people` (
	`person` text PRIMARY KEY NOT NULL,
	`erased_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `people` ADD `entra_tenant` text;--> statement-breakpoint
ALTER TABLE `people` ADD `entra_oid` text;