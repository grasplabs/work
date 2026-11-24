CREATE TABLE `run_chat_sources` (
	`run_id` text NOT NULL,
	`source_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`person_id` text NOT NULL,
	PRIMARY KEY(`run_id`, `source_id`)
);
