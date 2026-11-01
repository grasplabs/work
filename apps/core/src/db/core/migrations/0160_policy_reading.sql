ALTER TABLE `policy_documents` ADD `read_at` integer;--> statement-breakpoint
ALTER TABLE `policy_documents` ADD `error` text;--> statement-breakpoint
ALTER TABLE `policy_documents` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `policy_documents` ADD `proposals` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `policy_documents` ADD `unchecked` text DEFAULT '[]' NOT NULL;