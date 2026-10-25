-- GRA-1084: core's migration took every drawing the onboarding gave the
-- brain out (each part as drawn, however few told it). Forget whom they
-- rested on, and give every team that was given before again, to be
-- drawn into the brain as checked.
DELETE FROM `brain_sent` WHERE `type` = 'workflowVersion';--> statement-breakpoint
UPDATE `brain_teams` SET `due_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `sent_at` IS NOT NULL AND `due_at` IS NULL;
