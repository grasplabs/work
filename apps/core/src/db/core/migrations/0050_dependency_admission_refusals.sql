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
--> statement-breakpoint
-- A request is now only ever the resolver's, which stores the graph's lock
-- before it proposes it, and an approver is told Grasp resolved and checked
-- its packages. One that waits with no lock behind its graph was handed in
-- through the removed propose API, as its proposer stated it: it is dropped,
-- as a replaced request is, and the App resolves again.
DELETE FROM `dependency_requests` WHERE `status` = 'pending' AND NOT EXISTS (SELECT 1 FROM `dependency_locks` WHERE `dependency_locks`.`app_id` = `dependency_requests`.`app_id` AND `dependency_locks`.`graph_hash` = `dependency_requests`.`graph_hash`);
