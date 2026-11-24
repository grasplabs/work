CREATE TABLE `run_evidence_holds` (
	`run_id` text NOT NULL,
	`held_run_id` text NOT NULL,
	PRIMARY KEY(`run_id`, `held_run_id`)
);
--> statement-breakpoint
CREATE INDEX `run_evidence_holds_held_run_id_idx` ON `run_evidence_holds` (`held_run_id`);