CREATE TABLE `run_brain_memories` (
	`run_id` text NOT NULL,
	`memory_id` text NOT NULL,
	`permission_id` text NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `memory_id`, `permission_id`)
);
