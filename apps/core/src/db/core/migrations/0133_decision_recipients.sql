CREATE TABLE `workflow_decision_recipients` (
	`decision_id` text NOT NULL,
	`deciders` text NOT NULL,
	PRIMARY KEY(`decision_id`, `deciders`),
	FOREIGN KEY (`decision_id`) REFERENCES `workflow_decisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_decision_recipients_deciders_idx` ON `workflow_decision_recipients` (`deciders`,`decision_id`);--> statement-breakpoint
-- A decision's recipients are written once, with it: who may answer it
-- never changes after it was asked (decisions/decisions.ts).
CREATE TRIGGER `workflow_decision_recipients_immutable_update` BEFORE UPDATE ON `workflow_decision_recipients` BEGIN
	SELECT RAISE(ABORT, 'workflow_decision_recipients are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_decision_recipients_immutable_delete` BEFORE DELETE ON `workflow_decision_recipients` BEGIN
	SELECT RAISE(ABORT, 'workflow_decision_recipients are immutable');
END;
