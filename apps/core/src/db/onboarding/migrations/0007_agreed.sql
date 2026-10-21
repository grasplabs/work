ALTER TABLE `interview_states` ADD `agreed_at` text;--> statement-breakpoint
ALTER TABLE `interview_states` ADD `drawn_at` text;--> statement-breakpoint
-- Interviews agreed to before this column are drawn as well.
UPDATE `interview_states` SET `agreed_at` = `completed_at` WHERE `completed_at` IS NOT NULL;
