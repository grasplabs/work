ALTER TABLE `app_blueprints` ADD `permissions` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
DELETE FROM `permissions` WHERE `subject_type` = 'app' AND `subject_id` IN (SELECT `id` FROM `apps` WHERE `owner_id` = 'grasp');
