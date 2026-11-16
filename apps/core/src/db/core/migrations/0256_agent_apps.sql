CREATE TABLE `agent_apps` (
	`agent_id` text NOT NULL,
	`app` text NOT NULL,
	`name` text NOT NULL,
	`state` text NOT NULL,
	`source` text NOT NULL,
	`changed_by` text NOT NULL,
	`changed_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `app`)
);
