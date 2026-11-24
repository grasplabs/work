CREATE TABLE `preview_release_artifacts` (
	`chat_id` text NOT NULL,
	`app_id` text NOT NULL,
	`sha256` text NOT NULL,
	`content` text NOT NULL,
	PRIMARY KEY(`chat_id`, `app_id`, `sha256`)
);
--> statement-breakpoint
CREATE TABLE `preview_releases` (
	`chat_id` text NOT NULL,
	`app_id` text NOT NULL,
	`revision` integer NOT NULL,
	`version` integer NOT NULL,
	`manifest` text NOT NULL,
	`manifest_hash` text NOT NULL,
	PRIMARY KEY(`chat_id`, `app_id`)
);
--> statement-breakpoint
CREATE TABLE `preview_stores` (
	`store_id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`app_id` text NOT NULL,
	`revision` integer NOT NULL
);
