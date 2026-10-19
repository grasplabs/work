CREATE TABLE `sdk_preferences` (
	`person_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `sdk_store` ADD `preferences_generation` integer DEFAULT 0 NOT NULL;