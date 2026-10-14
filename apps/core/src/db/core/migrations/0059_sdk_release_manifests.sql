CREATE TABLE `sdk_release_manifests` (
	`app_id` text NOT NULL,
	`version` integer NOT NULL,
	`manifest_hash` text NOT NULL,
	`manifest` text NOT NULL,
	`sealed_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `version`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sdk_resource_bindings` (
	`resource_id` text NOT NULL,
	`resource_version` integer NOT NULL,
	`alias` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`schema_hash` text NOT NULL,
	`manifest_hash` text NOT NULL,
	PRIMARY KEY(`resource_id`, `resource_version`, `alias`)
);
--> statement-breakpoint
CREATE INDEX `sdk_resource_bindings_target` ON `sdk_resource_bindings` (`kind`,`target_id`);--> statement-breakpoint
CREATE TABLE `sdk_store_owners` (
	`store_id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`claimed_at` integer NOT NULL
);
