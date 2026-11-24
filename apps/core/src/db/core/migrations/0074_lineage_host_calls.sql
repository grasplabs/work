ALTER TABLE `run_lineage_attempts` ADD `host_calls` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `run_lineages` ADD `host_calls` integer DEFAULT 0 NOT NULL;