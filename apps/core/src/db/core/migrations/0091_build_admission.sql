CREATE TABLE `build_admission_queue` (
	`job_id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`resource` text NOT NULL,
	`enqueued_at` integer NOT NULL,
	`seen_at` integer NOT NULL,
	`waiting_for` text NOT NULL,
	`retry_at` integer NOT NULL,
	`turn` integer NOT NULL,
	`owner_seq` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `build_admission_queue_order_idx` ON `build_admission_queue` (`seen_at`,`turn`,`enqueued_at`);--> statement-breakpoint
CREATE INDEX `build_admission_queue_subject_idx` ON `build_admission_queue` (`subject`,`resource`,`seen_at`);--> statement-breakpoint
CREATE INDEX `build_admission_queue_resource_idx` ON `build_admission_queue` (`resource`,`seen_at`);--> statement-breakpoint
CREATE TABLE `build_commit_fences` (
	`job_id` text NOT NULL,
	`seq` integer NOT NULL,
	PRIMARY KEY(`job_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `build_leases` (
	`job_id` text NOT NULL,
	`seq` integer NOT NULL,
	`subject` text NOT NULL,
	`resource` text NOT NULL,
	`admitted_at` integer NOT NULL,
	`reserved_ms` integer NOT NULL,
	`settled_at` integer,
	`policy_generation` integer NOT NULL,
	PRIMARY KEY(`job_id`, `seq`)
);
--> statement-breakpoint
CREATE INDEX `build_leases_admitted_idx` ON `build_leases` (`admitted_at`);--> statement-breakpoint
CREATE INDEX `build_leases_resource_idx` ON `build_leases` (`resource`,`admitted_at`) WHERE settled_at IS NULL;--> statement-breakpoint
-- Hand-appended to drizzle-kit's output (it writes no triggers): whoever
-- regenerates this migration re-adds it; the build jobs' fence test fails
-- without it.
-- A build job's commit writes its fence first in its own transaction
-- (build-admission.ts): refused, and the commit with it, unless the lease
-- it names still holds as the transaction runs, by the database's clock:
-- unsettled, not ended, with no lease taken since it would have ended
-- (one taken then may have taken its share), and not superseded by a
-- newer step or attempt of its job (`stillHolds`, as renewals read it).
CREATE TRIGGER `build_commit_fences_held` BEFORE INSERT ON `build_commit_fences`
WHEN NOT EXISTS (
	SELECT 1 FROM `build_leases` AS l
	WHERE l.`job_id` = NEW.`job_id` AND l.`seq` = NEW.`seq`
		AND l.`settled_at` IS NULL
		AND l.`admitted_at` + l.`reserved_ms` > CAST(unixepoch('subsec') * 1000 AS INTEGER)
		AND NOT EXISTS (
			SELECT 1 FROM `build_leases` AS o
			WHERE o.`admitted_at` >= l.`admitted_at` + l.`reserved_ms`
				AND NOT (o.`job_id` = l.`job_id` AND o.`seq` = l.`seq`)
		)
		-- Nor once a newer step or attempt of its job went on without it.
		AND NOT EXISTS (
			SELECT 1 FROM `build_leases` AS n
			WHERE n.`job_id` = l.`job_id` AND n.`seq` > l.`seq`
		)
		AND NOT EXISTS (
			SELECT 1 FROM `build_admission_queue` AS q
			WHERE q.`job_id` = l.`job_id` AND q.`owner_seq` > l.`seq`
		)
)
BEGIN
	SELECT RAISE(ABORT, 'build lease no longer held');
END;
