CREATE TABLE `transcripts` (
	`document_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`turns` text NOT NULL,
	`chapters` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`,`version`) REFERENCES `versions`(`document_id`,`number`) ON UPDATE no action ON DELETE cascade
);
