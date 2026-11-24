CREATE TABLE `chat_file_parts` (
	`file_id` text NOT NULL,
	`part` integer NOT NULL,
	`bytes` blob NOT NULL,
	PRIMARY KEY(`file_id`, `part`),
	FOREIGN KEY (`file_id`) REFERENCES `chat_files`(`id`) ON UPDATE no action ON DELETE no action
);
