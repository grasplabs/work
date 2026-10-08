CREATE TABLE `dependency_admission_refusals` (
	`app_id` text NOT NULL,
	`graph_hash` text NOT NULL,
	`targets` text NOT NULL,
	`policy_generation` integer NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `graph_hash`, `targets`, `policy_generation`, `reason`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- Pins are now keyed by target config, with when each was pinned: one in
-- the old shape is dropped, and its target built again under the new one.
UPDATE `dependency_locks` SET `lock` = json_remove(`lock`, '$.artifacts') WHERE json_type(`lock`, '$.artifacts') IS NOT NULL;
