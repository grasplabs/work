CREATE TABLE `brain_memory_cites` (
	`memory_id` text NOT NULL,
	`collection_id` text NOT NULL,
	PRIMARY KEY(`memory_id`, `collection_id`),
	FOREIGN KEY (`memory_id`) REFERENCES `brain_memories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `brain_memory_cites_collection_idx` ON `brain_memory_cites` (`collection_id`,`memory_id`);