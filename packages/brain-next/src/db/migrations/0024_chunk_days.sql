CREATE TABLE `chunk_days` (
	`chunk` integer NOT NULL,
	`month_day` integer NOT NULL,
	`year` integer NOT NULL,
	PRIMARY KEY(`month_day`, `year`, `chunk`),
	FOREIGN KEY (`chunk`) REFERENCES `chunks`(`row`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chunk_days_chunk_idx` ON `chunk_days` (`chunk`);