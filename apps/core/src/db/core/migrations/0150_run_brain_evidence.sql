CREATE TABLE `run_brain_evidence` (
	`run_id` text NOT NULL,
	`binding` text NOT NULL,
	`pack_id` text NOT NULL,
	`collection_ids` text NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `binding`)
);
