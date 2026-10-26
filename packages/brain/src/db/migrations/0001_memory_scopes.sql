ALTER TABLE `brain_memories` ADD `scope_id` text;--> statement-breakpoint
CREATE INDEX `brain_memories_scope_idx` ON `brain_memories` (`scope`,`scope_id`,`recorded_at`);