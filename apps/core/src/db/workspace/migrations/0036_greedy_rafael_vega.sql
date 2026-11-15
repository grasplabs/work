CREATE TABLE `memory_uses` (
	`store` text NOT NULL,
	`memory` text NOT NULL,
	`used_at` integer NOT NULL,
	PRIMARY KEY(`store`, `memory`)
);
