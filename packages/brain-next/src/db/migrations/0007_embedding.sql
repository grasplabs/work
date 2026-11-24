CREATE TABLE `embedding_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`model` text,
	`walked_to` integer NOT NULL,
	`walked` integer NOT NULL,
	`rebuilt` integer NOT NULL,
	CONSTRAINT "embedding_state_one" CHECK(id = 1)
);
--> statement-breakpoint
CREATE TABLE `unembeddable` (
	`model` text NOT NULL,
	`hash` text NOT NULL,
	PRIMARY KEY(`model`, `hash`)
);
--> statement-breakpoint
CREATE TABLE `vector_files` (
	`model` text NOT NULL,
	`hash` text NOT NULL,
	`written_at` integer NOT NULL,
	`in_doubt_until` integer,
	`unheld` integer NOT NULL,
	PRIMARY KEY(`model`, `hash`)
);
--> statement-breakpoint
CREATE INDEX `vector_files_hash_idx` ON `vector_files` (`hash`);--> statement-breakpoint
CREATE INDEX `vector_files_unheld_idx` ON `vector_files` (`written_at`) WHERE unheld = 1;--> statement-breakpoint
ALTER TABLE `chunks` ADD `hash` text;--> statement-breakpoint
CREATE INDEX `chunks_hash_idx` ON `chunks` (`hash`);