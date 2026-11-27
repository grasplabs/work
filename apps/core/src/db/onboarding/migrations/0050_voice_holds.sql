CREATE TABLE `voice_holds` (
	`who` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`seconds` real NOT NULL,
	`at` text NOT NULL
);
