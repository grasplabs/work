CREATE TABLE `agent_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`bytes` integer NOT NULL,
	`text` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_documents_name_idx` ON `agent_documents` (`agent_id`,`name`);