CREATE TABLE `workflow_admission_queue` (
	`run_id` text NOT NULL,
	`step_hash` text NOT NULL,
	`subject` text NOT NULL,
	`resource` text NOT NULL,
	`enqueued_at` integer NOT NULL,
	`seen_at` integer NOT NULL,
	`waiting_for` text NOT NULL,
	`retry_at` integer NOT NULL,
	`turn` integer NOT NULL,
	`attempt_deadline` integer NOT NULL,
	PRIMARY KEY(`run_id`, `step_hash`)
);
--> statement-breakpoint
CREATE INDEX `workflow_admission_queue_order_idx` ON `workflow_admission_queue` (`seen_at`,`turn`,`enqueued_at`);--> statement-breakpoint
CREATE INDEX `workflow_admission_queue_subject_idx` ON `workflow_admission_queue` (`subject`,`resource`,`seen_at`);--> statement-breakpoint
CREATE INDEX `workflow_admission_queue_resource_idx` ON `workflow_admission_queue` (`resource`,`seen_at`);--> statement-breakpoint
ALTER TABLE `run_lineage_attempts` ADD `subject` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `run_lineage_attempts` ADD `resource` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `run_lineage_attempts` ADD `step_hash` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `run_lineage_attempts_running_idx` ON `run_lineage_attempts` (`admitted_at`) WHERE settled_at IS NULL;--> statement-breakpoint
CREATE INDEX `run_lineage_attempts_subject_idx` ON `run_lineage_attempts` (`subject`,`admitted_at`) WHERE settled_at IS NULL;--> statement-breakpoint
CREATE INDEX `run_lineage_attempts_resource_idx` ON `run_lineage_attempts` (`resource`,`admitted_at`) WHERE settled_at IS NULL;