-- Dependency requests, approvals, locks, builds and refused admissions
-- for a subject that is an App or an independent workflow resource
-- (GRA-665): `subject_type` (`app`, `workflow`) and `subject_id` take the
-- place of `app_id`, whose foreign key to `apps` named one table only. A
-- trigger of each table refuses a subject neither `apps` nor
-- `workflow_resources` has, and a row never moves to another subject, as
-- the key did. No table refers to these four, so each is made again under
-- a new name and renamed. What was the App's stays the App's.
CREATE TABLE `__new_dependency_admission_refusals` (
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`graph_hash` text NOT NULL,
	`targets` text NOT NULL,
	`policy_generation` integer NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`subject_type`, `subject_id`, `graph_hash`, `targets`, `policy_generation`, `reason`)
);
--> statement-breakpoint
INSERT INTO `__new_dependency_admission_refusals`("subject_type", "subject_id", "graph_hash", "targets", "policy_generation", "reason", "created_at") SELECT 'app', "app_id", "graph_hash", "targets", "policy_generation", "reason", "created_at" FROM `dependency_admission_refusals`;
--> statement-breakpoint
DROP TABLE `dependency_admission_refusals`;
--> statement-breakpoint
ALTER TABLE `__new_dependency_admission_refusals` RENAME TO `dependency_admission_refusals`;
--> statement-breakpoint
CREATE TABLE `__new_dependency_build_leases` (
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`graph_hash` text NOT NULL,
	`target` text NOT NULL,
	`holder` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`subject_type`, `subject_id`, `graph_hash`, `target`)
);
--> statement-breakpoint
INSERT INTO `__new_dependency_build_leases`("subject_type", "subject_id", "graph_hash", "target", "holder", "expires_at") SELECT 'app', "app_id", "graph_hash", "target", "holder", "expires_at" FROM `dependency_build_leases`;
--> statement-breakpoint
DROP TABLE `dependency_build_leases`;
--> statement-breakpoint
ALTER TABLE `__new_dependency_build_leases` RENAME TO `dependency_build_leases`;
--> statement-breakpoint
CREATE INDEX `dependency_build_leases_expires_at_idx` ON `dependency_build_leases` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `__new_dependency_locks` (
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`graph_hash` text NOT NULL,
	`lock` text NOT NULL,
	`created_at` integer NOT NULL,
	`served_until` integer,
	PRIMARY KEY(`subject_type`, `subject_id`, `graph_hash`)
);
--> statement-breakpoint
INSERT INTO `__new_dependency_locks`("subject_type", "subject_id", "graph_hash", "lock", "created_at", "served_until") SELECT 'app', "app_id", "graph_hash", "lock", "created_at", "served_until" FROM `dependency_locks`;
--> statement-breakpoint
DROP TABLE `dependency_locks`;
--> statement-breakpoint
ALTER TABLE `__new_dependency_locks` RENAME TO `dependency_locks`;
--> statement-breakpoint
CREATE TABLE `__new_dependency_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`source_revision` text NOT NULL,
	`graph_hash` text NOT NULL,
	`targets` text NOT NULL,
	`purpose` text NOT NULL,
	`snapshot` text NOT NULL,
	`summary` text NOT NULL,
	`direct` integer NOT NULL,
	`packages` integer NOT NULL,
	`findings` integer NOT NULL,
	`refused` integer NOT NULL,
	`previous` text,
	`status` text NOT NULL,
	`requested_by` text NOT NULL,
	`requested_via` text,
	`requested_at` integer NOT NULL,
	`policy_generation` integer NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`decided_generation` integer,
	`reason` text,
	`ended_by` text,
	`ended_at` integer,
	`ended_generation` integer,
	`ended_reason` text
);
--> statement-breakpoint
INSERT INTO `__new_dependency_requests`("id", "subject_type", "subject_id", "source_revision", "graph_hash", "targets", "purpose", "snapshot", "summary", "direct", "packages", "findings", "refused", "previous", "status", "requested_by", "requested_via", "requested_at", "policy_generation", "decided_by", "decided_at", "decided_generation", "reason", "ended_by", "ended_at", "ended_generation", "ended_reason") SELECT "id", 'app', "app_id", "source_revision", "graph_hash", "targets", "purpose", "snapshot", "summary", "direct", "packages", "findings", "refused", "previous", "status", "requested_by", "requested_via", "requested_at", "policy_generation", "decided_by", "decided_at", "decided_generation", "reason", "ended_by", "ended_at", "ended_generation", "ended_reason" FROM `dependency_requests`;
--> statement-breakpoint
DROP TABLE `dependency_requests`;
--> statement-breakpoint
ALTER TABLE `__new_dependency_requests` RENAME TO `dependency_requests`;
--> statement-breakpoint
CREATE UNIQUE INDEX `dependency_requests_pending_idx` ON `dependency_requests` (`subject_type`,`subject_id`) WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX `dependency_requests_subject_idx` ON `dependency_requests` (`subject_type`,`subject_id`,`status`,`decided_at`);
--> statement-breakpoint
CREATE INDEX `dependency_requests_graph_idx` ON `dependency_requests` (`subject_type`,`subject_id`,`graph_hash`,`status`);
--> statement-breakpoint
CREATE TRIGGER `dependency_admission_refusals_of_subjects` BEFORE INSERT ON `dependency_admission_refusals`
WHEN NOT (
	(NEW.`subject_type` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`subject_id`))
	OR (NEW.`subject_type` = 'workflow' AND EXISTS (SELECT 1 FROM `workflow_resources` WHERE `id` = NEW.`subject_id`))
)
BEGIN
	SELECT RAISE(ABORT, 'dependency_admission_refusals are of an App or a workflow core has');
END;
--> statement-breakpoint
CREATE TRIGGER `dependency_admission_refusals_subject_kept` BEFORE UPDATE OF `subject_type`, `subject_id` ON `dependency_admission_refusals`
WHEN NEW.`subject_type` IS NOT OLD.`subject_type` OR NEW.`subject_id` IS NOT OLD.`subject_id`
BEGIN
	SELECT RAISE(ABORT, 'dependency_admission_refusals keep their subject');
END;
--> statement-breakpoint
CREATE TRIGGER `dependency_build_leases_of_subjects` BEFORE INSERT ON `dependency_build_leases`
WHEN NOT (
	(NEW.`subject_type` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`subject_id`))
	OR (NEW.`subject_type` = 'workflow' AND EXISTS (SELECT 1 FROM `workflow_resources` WHERE `id` = NEW.`subject_id`))
)
BEGIN
	SELECT RAISE(ABORT, 'dependency_build_leases are of an App or a workflow core has');
END;
--> statement-breakpoint
CREATE TRIGGER `dependency_build_leases_subject_kept` BEFORE UPDATE OF `subject_type`, `subject_id` ON `dependency_build_leases`
WHEN NEW.`subject_type` IS NOT OLD.`subject_type` OR NEW.`subject_id` IS NOT OLD.`subject_id`
BEGIN
	SELECT RAISE(ABORT, 'dependency_build_leases keep their subject');
END;
--> statement-breakpoint
CREATE TRIGGER `dependency_locks_of_subjects` BEFORE INSERT ON `dependency_locks`
WHEN NOT (
	(NEW.`subject_type` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`subject_id`))
	OR (NEW.`subject_type` = 'workflow' AND EXISTS (SELECT 1 FROM `workflow_resources` WHERE `id` = NEW.`subject_id`))
)
BEGIN
	SELECT RAISE(ABORT, 'dependency_locks are of an App or a workflow core has');
END;
--> statement-breakpoint
CREATE TRIGGER `dependency_locks_subject_kept` BEFORE UPDATE OF `subject_type`, `subject_id` ON `dependency_locks`
WHEN NEW.`subject_type` IS NOT OLD.`subject_type` OR NEW.`subject_id` IS NOT OLD.`subject_id`
BEGIN
	SELECT RAISE(ABORT, 'dependency_locks keep their subject');
END;
--> statement-breakpoint
CREATE TRIGGER `dependency_requests_of_subjects` BEFORE INSERT ON `dependency_requests`
WHEN NOT (
	(NEW.`subject_type` = 'app' AND EXISTS (SELECT 1 FROM `apps` WHERE `id` = NEW.`subject_id`))
	OR (NEW.`subject_type` = 'workflow' AND EXISTS (SELECT 1 FROM `workflow_resources` WHERE `id` = NEW.`subject_id`))
)
BEGIN
	SELECT RAISE(ABORT, 'dependency_requests are of an App or a workflow core has');
END;
--> statement-breakpoint
CREATE TRIGGER `dependency_requests_subject_kept` BEFORE UPDATE OF `subject_type`, `subject_id` ON `dependency_requests`
WHEN NEW.`subject_type` IS NOT OLD.`subject_type` OR NEW.`subject_id` IS NOT OLD.`subject_id`
BEGIN
	SELECT RAISE(ABORT, 'dependency_requests keep their subject');
END;
