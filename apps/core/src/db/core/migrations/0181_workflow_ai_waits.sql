CREATE TABLE `workflow_ai_waits` (
	`run_id` text NOT NULL,
	`run_kind` text NOT NULL,
	`step_hash` text NOT NULL,
	`provider` text NOT NULL,
	`trouble` text NOT NULL,
	`since` integer NOT NULL,
	PRIMARY KEY(`run_id`, `step_hash`)
);
