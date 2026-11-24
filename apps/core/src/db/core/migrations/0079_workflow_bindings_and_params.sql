CREATE TABLE `app_workflow_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`alias` text NOT NULL,
	`workflow_resource_id` text NOT NULL,
	`workflow_resource_version` integer NOT NULL,
	`status` text NOT NULL,
	`bound_by` text NOT NULL,
	`bound_at` integer NOT NULL,
	`removed_by` text,
	`removed_at` integer,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_workflow_bindings_active_idx` ON `app_workflow_bindings` (`app_id`,`alias`) WHERE "app_workflow_bindings"."status" = 'active';--> statement-breakpoint
CREATE INDEX `app_workflow_bindings_workflow_idx` ON `app_workflow_bindings` (`workflow_resource_id`,`status`);--> statement-breakpoint
CREATE TABLE `workflow_binding_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_resource_id` text NOT NULL,
	`alias` text NOT NULL,
	`kind` text NOT NULL,
	`contract_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`target` text NOT NULL,
	`reviewed_version` integer NOT NULL,
	`status` text NOT NULL,
	`approved_by` text NOT NULL,
	`approved_at` integer NOT NULL,
	`revoked_by` text,
	`revoked_at` integer,
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_binding_approvals_active_idx` ON `workflow_binding_approvals` (`workflow_resource_id`,`reviewed_version`,`alias`) WHERE "workflow_binding_approvals"."status" = 'active';--> statement-breakpoint
CREATE TABLE `workflow_catalog_contracts` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`contract` text NOT NULL,
	`fingerprint` text NOT NULL,
	`published_by` text NOT NULL,
	`published_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_resource_params` (
	`workflow_resource_id` text NOT NULL,
	`revision` integer NOT NULL,
	`values` text,
	`set_by` text NOT NULL,
	`set_at` integer NOT NULL,
	`values_removed_at` integer,
	PRIMARY KEY(`workflow_resource_id`, `revision`),
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflow_start_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`invoker_type` text NOT NULL,
	`invoker_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`workflow_resource_id` text NOT NULL,
	`workflow_resource_version` integer NOT NULL,
	`manifest_hash` text NOT NULL,
	`origin_app_version` integer,
	`trigger_version` integer,
	`principal_id` text NOT NULL,
	`authority_generation` integer NOT NULL,
	`input` text,
	`input_hash` text NOT NULL,
	`params` text,
	`params_revision` integer DEFAULT 0 NOT NULL,
	`bindings` text DEFAULT '[]' NOT NULL,
	`bindings_hash` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`details_removed_at` integer,
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_workflow_start_receipts`("id", "invoker_type", "invoker_id", "idempotency_key", "workflow_resource_id", "workflow_resource_version", "manifest_hash", "origin_app_version", "trigger_version", "principal_id", "authority_generation", "input", "input_hash", "created_at") SELECT "id", "invoker_type", "invoker_id", "idempotency_key", "workflow_resource_id", "workflow_resource_version", "manifest_hash", "origin_app_version", "trigger_version", "principal_id", "authority_generation", "input", "input_hash", "created_at" FROM `workflow_start_receipts`;--> statement-breakpoint
DROP TABLE `workflow_start_receipts`;--> statement-breakpoint
ALTER TABLE `__new_workflow_start_receipts` RENAME TO `workflow_start_receipts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_start_receipts_key` ON `workflow_start_receipts` (`invoker_type`,`invoker_id`,`principal_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `workflow_start_receipts_workflow` ON `workflow_start_receipts` (`workflow_resource_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `workflow_start_receipts_due` ON `workflow_start_receipts` (`created_at`) WHERE "workflow_start_receipts"."details_removed_at" IS NULL;--> statement-breakpoint
ALTER TABLE `workflow_resources` ADD `config_revision` integer DEFAULT 0 NOT NULL;