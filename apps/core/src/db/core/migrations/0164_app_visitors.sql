CREATE TABLE `app_visitor_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`address` text NOT NULL,
	`code_hash` text NOT NULL,
	`tries` integer NOT NULL,
	`used_at` integer,
	`sent_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `app_visitor_codes_address_idx` ON `app_visitor_codes` (`app_id`,`address`,`sent_at`);--> statement-breakpoint
CREATE INDEX `app_visitor_codes_sent_idx` ON `app_visitor_codes` (`app_id`,`sent_at`);--> statement-breakpoint
CREATE INDEX `app_visitor_codes_sweep_idx` ON `app_visitor_codes` (`sent_at`);--> statement-breakpoint
CREATE TABLE `app_visitor_entries` (
	`app_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `kind`, `value`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `app_visitor_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`address` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_visitor_sessions_token_idx` ON `app_visitor_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `app_visitor_sessions_expires_idx` ON `app_visitor_sessions` (`expires_at`);