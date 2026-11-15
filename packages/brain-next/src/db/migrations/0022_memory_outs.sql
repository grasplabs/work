CREATE TABLE `memory_ins` (
	`memory` integer PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	FOREIGN KEY (`memory`) REFERENCES `memories`(`row`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_ins_source_idx` ON `memory_ins` (`source`);--> statement-breakpoint
CREATE TABLE `memory_outs` (
	`memory` integer PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`pair` text,
	FOREIGN KEY (`memory`) REFERENCES `memories`(`row`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_outs_pair_idx` ON `memory_outs` (`source`,`pair`);--> statement-breakpoint
ALTER TABLE `current_versions` ADD `judged_row` integer;--> statement-breakpoint
ALTER TABLE `source_subjects` ADD `thread` integer DEFAULT false NOT NULL;