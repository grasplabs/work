CREATE TABLE `migration_sample_leases` (
	`app_id` text NOT NULL,
	`version` integer NOT NULL,
	`migration` text NOT NULL,
	`token` text NOT NULL,
	`until` integer NOT NULL,
	PRIMARY KEY(`app_id`, `version`, `migration`)
);
--> statement-breakpoint
CREATE TABLE `migration_samples` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`version` integer NOT NULL,
	`migration` text NOT NULL,
	`store_id` text NOT NULL,
	`outcome` text NOT NULL,
	`rows` integer NOT NULL,
	`owners` integer NOT NULL,
	`reason` text,
	`manifest_hash` text NOT NULL,
	`from_schema` text NOT NULL,
	`to_schema` text NOT NULL,
	`sampled_by` text NOT NULL,
	`sampled_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `migration_samples_latest_idx` ON `migration_samples` (`app_id`,`version`,`migration`,`sampled_at`);
--> statement-breakpoint
-- A sample's receipt is evidence: append-only, as the frozen workflow
-- records are (0080, 0101). Neither updated, nor deleted, nor replaced by
-- an insert over its key or its rowid; the latest receipt decides, so
-- rewriting an old one could change what gates a version.
CREATE TRIGGER `migration_samples_immutable_update` BEFORE UPDATE ON `migration_samples` BEGIN
	SELECT RAISE(ABORT, 'migration_samples are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_samples_immutable_delete` BEFORE DELETE ON `migration_samples` BEGIN
	SELECT RAISE(ABORT, 'migration_samples are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_samples_immutable_insert` BEFORE INSERT ON `migration_samples`
WHEN EXISTS (
	SELECT 1 FROM `migration_samples` WHERE `id` = NEW.`id`
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: migration_samples.id (migration_samples are immutable)');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_samples_immutable_insert_rowid` BEFORE INSERT ON `migration_samples`
WHEN EXISTS (
	SELECT 1 FROM `migration_samples` WHERE rowid = NEW.rowid AND NEW.rowid <> -1
) BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: migration_samples.rowid (migration_samples are immutable)');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_samples_rowid_reserved` AFTER INSERT ON `migration_samples`
WHEN NEW.rowid = -1
BEGIN
	SELECT RAISE(ABORT, 'migration_samples keep rowid -1 for an insert that names none');
END;
