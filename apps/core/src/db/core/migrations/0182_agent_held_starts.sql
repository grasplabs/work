CREATE TABLE `agent_held_starts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`person_id` text NOT NULL,
	`workflow_resource_id` text NOT NULL,
	`workflow_resource_version` integer NOT NULL,
	`input` text NOT NULL,
	`input_hash` text NOT NULL,
	`key` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`decision` text,
	`decided_at` integer,
	`start_id` text,
	`refusal` text,
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_held_starts_key` ON `agent_held_starts` (`chat_id`,`key`);--> statement-breakpoint
CREATE INDEX `agent_held_starts_person` ON `agent_held_starts` (`person_id`,`created_at`) WHERE "agent_held_starts"."decision" IS NULL;