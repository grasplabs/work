CREATE TABLE `run_state_writers` (
	`run_id` text NOT NULL,
	`writer_run_id` text NOT NULL,
	PRIMARY KEY(`run_id`, `writer_run_id`)
);
--> statement-breakpoint
CREATE INDEX `run_state_writers_writer_idx` ON `run_state_writers` (`writer_run_id`);