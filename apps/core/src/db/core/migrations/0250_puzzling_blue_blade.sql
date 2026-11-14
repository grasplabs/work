CREATE TABLE `skill_proposal_dismissals` (
	`person_id` text NOT NULL,
	`workflow_resource_id` text NOT NULL,
	`version` integer NOT NULL,
	`dismissed_at` integer NOT NULL,
	PRIMARY KEY(`person_id`, `workflow_resource_id`, `version`)
);
