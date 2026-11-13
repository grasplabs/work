DROP INDEX `skill_decisions_seq_idx`;--> statement-breakpoint
DROP INDEX `skill_decisions_open_idx`;--> statement-breakpoint
ALTER TABLE `skill_decisions` ADD `audience` text;--> statement-breakpoint
CREATE UNIQUE INDEX `skill_decisions_sequence_idx` ON `skill_decisions` (`audience`,`name`,`seq`);--> statement-breakpoint
CREATE INDEX `skill_decisions_open_idx` ON `skill_decisions` (`audience`,`name`) WHERE outcome IS NULL;--> statement-breakpoint
DROP INDEX `skill_shares_pending_idx`;--> statement-breakpoint
ALTER TABLE `skill_shares` ADD `audience` text;--> statement-breakpoint
CREATE UNIQUE INDEX `skill_shares_waiting_idx` ON `skill_shares` (`requested_by`,`name`,`audience`) WHERE status = 'pending';