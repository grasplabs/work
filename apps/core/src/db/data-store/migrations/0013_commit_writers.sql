CREATE TABLE `sdk_commit_writers` (
	`commit` integer PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`resource_version` integer NOT NULL,
	`principal` text NOT NULL,
	`committed_at` integer NOT NULL
);
