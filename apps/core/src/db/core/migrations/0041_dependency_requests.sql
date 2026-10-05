CREATE TABLE `dependency_policy` (
	`id` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dependency_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`source_revision` text NOT NULL,
	`graph_hash` text NOT NULL,
	`targets` text NOT NULL,
	`purpose` text NOT NULL,
	`snapshot` text NOT NULL,
	`direct` integer NOT NULL,
	`packages` integer NOT NULL,
	`findings` integer NOT NULL,
	`refused` integer NOT NULL,
	`previous` text,
	`status` text NOT NULL,
	`requested_by` text NOT NULL,
	`requested_via` text,
	`requested_at` integer NOT NULL,
	`policy_generation` integer NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`decided_generation` integer,
	`reason` text,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dependency_requests_pending_idx` ON `dependency_requests` (`app_id`) WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX `dependency_requests_app_idx` ON `dependency_requests` (`app_id`,`status`,`requested_at`);