-- Release channels, and each client's last deploy by the reconciler: every existing client follows Stable (the column's default), and no channel has a release yet.
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`release_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `client_deploys` (
	`client_id` text PRIMARY KEY NOT NULL,
	`release_id` text NOT NULL,
	`run_id` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `clients` ADD `channel` text DEFAULT 'stable' NOT NULL;--> statement-breakpoint
CREATE INDEX `clients_status_channel_idx` ON `clients` (`status`,`channel`);--> statement-breakpoint
CREATE INDEX `audit_events_action_idx` ON `audit_events` (`action`,`target`);