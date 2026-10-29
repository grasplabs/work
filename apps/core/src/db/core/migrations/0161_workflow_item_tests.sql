-- Tests of a draft's checkpoint over recent real items, one row per item
-- (workflows/item-tests.ts, GRA-513).
CREATE TABLE `workflow_item_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`test_id` text NOT NULL,
	`workflow_resource_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`draft_revision` integer NOT NULL,
	`position` integer NOT NULL,
	`source_run_id` text NOT NULL,
	`candidate_run_id` text,
	`refusal_code` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workflow_resource_id`) REFERENCES `workflow_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_item_tests_position_idx` ON `workflow_item_tests` (`test_id`,`position`);--> statement-breakpoint
CREATE INDEX `workflow_item_tests_created_idx` ON `workflow_item_tests` (`created_at`);--> statement-breakpoint
CREATE INDEX `workflow_item_tests_candidate_idx` ON `workflow_item_tests` (`candidate_run_id`);
--> statement-breakpoint
-- An item's row records what happened to it: none changes.
CREATE TRIGGER `workflow_item_tests_kept` BEFORE UPDATE ON `workflow_item_tests`
BEGIN
	SELECT RAISE(ABORT, 'workflow_item_tests record what happened');
END;
