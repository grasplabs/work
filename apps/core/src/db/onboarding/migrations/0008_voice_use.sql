CREATE TABLE `voice_use` (
	`who` text NOT NULL,
	`day` text NOT NULL,
	`seconds` real NOT NULL,
	PRIMARY KEY(`who`, `day`)
);
