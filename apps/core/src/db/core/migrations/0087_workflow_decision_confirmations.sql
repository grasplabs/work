CREATE TABLE `workflow_decision_confirmations` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`decision_id` text NOT NULL,
	`user_id` text NOT NULL,
	`context_fingerprint` text NOT NULL,
	`response_fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`decision_id`) REFERENCES `workflow_decisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_decision_confirmations_decision_user_idx` ON `workflow_decision_confirmations` (`decision_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `workflow_decision_confirmations_expires_idx` ON `workflow_decision_confirmations` (`expires_at`);