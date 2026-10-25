CREATE TABLE `channel_signals` (
	`hour` integer NOT NULL,
	`platform` text NOT NULL,
	`signal` text NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`hour`, `platform`, `signal`)
);
