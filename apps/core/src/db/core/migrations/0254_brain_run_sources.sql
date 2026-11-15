CREATE TABLE `brain_run_sources` (
	`person_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`in_use` integer DEFAULT true NOT NULL,
	`revoked_at` integer,
	`runs` integer,
	`removal_owed` integer DEFAULT false NOT NULL,
	`removed_through_at` integer,
	`removed_through` text,
	PRIMARY KEY(`person_id`, `workflow_id`)
);
--> statement-breakpoint
CREATE INDEX `brain_run_sources_in_use_idx` ON `brain_run_sources` (`person_id`,`workflow_id`) WHERE in_use = 1;--> statement-breakpoint
CREATE INDEX `brain_run_sources_owed_idx` ON `brain_run_sources` (`revoked_at`) WHERE removal_owed = 1;