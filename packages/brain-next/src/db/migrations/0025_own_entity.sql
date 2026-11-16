CREATE TABLE `own_entity` (
	`id` integer PRIMARY KEY NOT NULL,
	`entity` integer NOT NULL,
	FOREIGN KEY (`entity`) REFERENCES `entities`(`row`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "own_entity_one" CHECK(id = 1)
);
