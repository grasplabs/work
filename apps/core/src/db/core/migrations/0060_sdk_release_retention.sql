CREATE TABLE `sdk_artifact_deletions` (
	`sha256` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sdk_release_artifacts` (
	`sha256` text NOT NULL,
	`app_id` text NOT NULL,
	`version` integer NOT NULL,
	`reserved_at` integer NOT NULL,
	PRIMARY KEY(`sha256`, `app_id`, `version`)
);
--> statement-breakpoint
CREATE INDEX `sdk_release_artifacts_release` ON `sdk_release_artifacts` (`app_id`,`version`);--> statement-breakpoint
CREATE TABLE `sdk_release_pins` (
	`app_id` text NOT NULL,
	`version` integer NOT NULL,
	`holder_kind` text NOT NULL,
	`holder_id` text NOT NULL,
	`expires_at` integer,
	`pinned_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `version`, `holder_kind`, `holder_id`)
);
--> statement-breakpoint
CREATE TABLE `sdk_release_tombstones` (
	`app_id` text NOT NULL,
	`version` integer NOT NULL,
	`manifest_hash` text NOT NULL,
	`deleted_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `version`)
);
--> statement-breakpoint
ALTER TABLE `sdk_release_manifests` ADD `last_current_at` integer;--> statement-breakpoint
ALTER TABLE `sdk_release_manifests` ADD `unreferenced_since` integer;--> statement-breakpoint
ALTER TABLE `sdk_release_manifests` ADD `revoked_at` integer;