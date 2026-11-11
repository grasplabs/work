CREATE TABLE `vector_blocks` (
	`id` integer PRIMARY KEY NOT NULL,
	`model` integer NOT NULL,
	`reader_set` integer NOT NULL,
	`chunks` blob NOT NULL,
	`bits` blob NOT NULL,
	FOREIGN KEY (`model`) REFERENCES `vector_models`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reader_set`) REFERENCES `reader_sets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `vector_blocks_group_idx` ON `vector_blocks` (`model`,`reader_set`);--> statement-breakpoint
CREATE TABLE `vector_codes` (
	`chunk` integer NOT NULL,
	`model` integer NOT NULL,
	`reader_set` integer NOT NULL,
	`bits` blob NOT NULL,
	`inverse_length` real NOT NULL,
	`fine` blob NOT NULL,
	`block` integer,
	`slot` integer,
	PRIMARY KEY(`chunk`, `model`),
	FOREIGN KEY (`chunk`) REFERENCES `chunks`(`row`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model`) REFERENCES `vector_models`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reader_set`) REFERENCES `reader_sets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`block`) REFERENCES `vector_blocks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `vector_codes_group_idx` ON `vector_codes` (`model`,`reader_set`,`block`);--> statement-breakpoint
CREATE INDEX `vector_codes_block_idx` ON `vector_codes` (`block`,`slot`);--> statement-breakpoint
CREATE TABLE `vector_models` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`centre` blob NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vector_models_name_unique` ON `vector_models` (`name`);--> statement-breakpoint
CREATE TABLE `vector_removed` (
	`block` integer NOT NULL,
	`slot` integer NOT NULL,
	PRIMARY KEY(`block`, `slot`),
	FOREIGN KEY (`block`) REFERENCES `vector_blocks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- A packed block is written once and never changed: a repack writes a new
-- one and deletes the old. A model's centre is fixed by its first codes.
CREATE TRIGGER `vector_blocks_no_update` BEFORE UPDATE ON `vector_blocks` BEGIN
	SELECT RAISE(ABORT, 'vector blocks are added and deleted, never updated');
END;
--> statement-breakpoint
CREATE TRIGGER `vector_models_no_update` BEFORE UPDATE ON `vector_models` BEGIN
	SELECT RAISE(ABORT, 'vector models are added, never updated');
END;
