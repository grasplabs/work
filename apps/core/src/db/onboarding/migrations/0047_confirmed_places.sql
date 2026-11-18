CREATE TABLE `confirmed_places` (
	`email` text PRIMARY KEY NOT NULL,
	`team` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `erased_people` (
	`person` text PRIMARY KEY NOT NULL,
	`erased_at` text NOT NULL
);
