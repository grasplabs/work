CREATE TABLE `memory_replacements` (
	`memory` integer NOT NULL,
	`replaced` integer NOT NULL,
	`undone_at` integer,
	PRIMARY KEY(`memory`, `replaced`),
	FOREIGN KEY (`memory`) REFERENCES `memories`(`row`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`replaced`) REFERENCES `memories`(`row`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_replacements_replaced_idx` ON `memory_replacements` (`replaced`);