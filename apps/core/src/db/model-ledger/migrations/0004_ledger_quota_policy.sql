CREATE TABLE `policy` (
	`id` integer PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	CONSTRAINT "policy_one_row" CHECK("policy"."id" = 0),
	CONSTRAINT "policy_generation" CHECK("policy"."generation" >= 0)
);
--> statement-breakpoint
ALTER TABLE `requests` ADD `policy_generation` integer;