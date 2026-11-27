CREATE TABLE `chat_deletes` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`person` text NOT NULL,
	`actor` text NOT NULL,
	`audited` integer NOT NULL,
	`declined` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_at` integer NOT NULL
);
