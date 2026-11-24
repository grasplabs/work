CREATE TABLE `app_entries` (
	`app_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`described` text,
	`indexed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `collection_teams` (
	`collection_id` text NOT NULL,
	`team_id` text NOT NULL,
	PRIMARY KEY(`collection_id`, `team_id`)
);
--> statement-breakpoint
CREATE INDEX `collection_teams_team_id_idx` ON `collection_teams` (`team_id`);--> statement-breakpoint
CREATE TABLE `knowledge_signal_computations` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `knowledge_signal_computations_day_idx` ON `knowledge_signal_computations` (`day`);--> statement-breakpoint
CREATE INDEX `knowledge_signal_computations_started_idx` ON `knowledge_signal_computations` (`started_at`,`id`);--> statement-breakpoint
CREATE TABLE `knowledge_signal_dismissals` (
	`kind` text NOT NULL,
	`collection_id` text NOT NULL,
	`subject` text NOT NULL,
	`dismissed_at` integer NOT NULL,
	PRIMARY KEY(`kind`, `collection_id`, `subject`)
);
--> statement-breakpoint
CREATE TABLE `knowledge_signals` (
	`computation` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`collection_id` text NOT NULL,
	`subject` text NOT NULL,
	`owner` text NOT NULL,
	`value` integer,
	`evidence` text NOT NULL,
	`evidence_at` integer,
	PRIMARY KEY(`computation`, `id`),
	FOREIGN KEY (`computation`) REFERENCES `knowledge_signal_computations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_signals_subject_idx` ON `knowledge_signals` (`computation`,`collection_id`,`kind`,`subject`);--> statement-breakpoint
CREATE INDEX `knowledge_signals_owner_idx` ON `knowledge_signals` (`computation`,`owner`,`kind`,`value`,`id`);--> statement-breakpoint
CREATE TABLE `upload_cleanups` (
	`key` text PRIMARY KEY NOT NULL,
	`upload_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`path` text NOT NULL,
	`media_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`uploaded_by` text NOT NULL,
	`actor` text NOT NULL,
	`status` text NOT NULL,
	`failure` text,
	`document_id` text,
	`version` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `uploads_path_idx` ON `uploads` (`collection_id`,`path`,`created_at`);--> statement-breakpoint
CREATE INDEX `uploads_original_idx` ON `uploads` (`collection_id`,`sha256`);--> statement-breakpoint
CREATE INDEX `uploads_status_idx` ON `uploads` (`status`,`updated_at`);