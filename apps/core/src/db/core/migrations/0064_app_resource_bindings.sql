CREATE TABLE `app_resource_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`alias` text NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`declaration_hash` text NOT NULL,
	`contract_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`reviewed_version` integer NOT NULL,
	`status` text NOT NULL,
	`approved_by` text NOT NULL,
	`approved_at` integer NOT NULL,
	`revoked_by` text,
	`revoked_at` integer,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_resource_bindings_active_idx` ON `app_resource_bindings` (`app_id`,`alias`) WHERE "app_resource_bindings"."status" = 'active';