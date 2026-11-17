CREATE TABLE `connection_brain_erasures` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`erasing` integer NOT NULL,
	`request` text NOT NULL,
	`actor` text NOT NULL,
	`requested_at` integer NOT NULL,
	`erased` integer NOT NULL,
	`closed` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `connection_brain_erasures_erasing_idx` ON `connection_brain_erasures` (`erasing`);--> statement-breakpoint
CREATE TABLE `connection_brain_reads` (
	`source_id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`generation` integer NOT NULL,
	`read_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `connection_brain_reads_connection_idx` ON `connection_brain_reads` (`connection_id`,`generation`);