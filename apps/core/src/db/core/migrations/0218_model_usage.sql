CREATE TABLE `model_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`period` text NOT NULL,
	`person_id` text,
	`trigger_type` text NOT NULL,
	`workflow_app_id` text,
	`workflow_id` text,
	`run_id` text,
	`binding_app_id` text,
	`binding_alias` text,
	`model` text NOT NULL,
	`credential` text NOT NULL,
	`feature` text,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`cost` real NOT NULL,
	`estimated` integer NOT NULL,
	`reported` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `model_usage_period_idx` ON `model_usage` (`period`,`credential`);--> statement-breakpoint
CREATE INDEX `model_usage_workflow_idx` ON `model_usage` (`period`,`workflow_app_id`,`workflow_id`);--> statement-breakpoint
CREATE INDEX `model_usage_binding_idx` ON `model_usage` (`period`,`binding_app_id`,`binding_alias`);--> statement-breakpoint
CREATE TABLE `provider_health` (
	`provider` text NOT NULL,
	`credential` text NOT NULL,
	`last_ok_at` integer,
	`last_failed_at` integer,
	`last_failure` text,
	`last_status` integer,
	`failing_class` text,
	`failing_since` integer,
	PRIMARY KEY(`provider`, `credential`)
);
