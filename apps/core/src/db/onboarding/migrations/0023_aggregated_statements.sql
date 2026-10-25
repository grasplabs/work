-- GRA-1084: core's migration took every statement the onboarding gave the
-- brain out (one person's fact each). Forget whom they rested on, and give
-- every team that was given before again, to be put together as claims.
DELETE FROM `brain_sent` WHERE `type` = 'statement';--> statement-breakpoint
UPDATE `brain_teams` SET `due_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `sent_at` IS NOT NULL AND `due_at` IS NULL;
