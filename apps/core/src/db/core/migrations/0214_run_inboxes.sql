CREATE TABLE `run_inboxes` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`binding` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_inboxes_run_binding_idx` ON `run_inboxes` (`run_id`,`binding`);