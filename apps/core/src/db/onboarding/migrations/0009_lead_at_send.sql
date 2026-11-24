-- Who led which team when their link went out, and which team a lead's
-- interview was for. Rows from before this migration stay NULL: nobody
-- counts as a lead from a guess at a past roster. Nothing was released
-- with links in it (hard cut), so no onboarding loses a lead's interview.
ALTER TABLE `interview_states` ADD `lead_of` text;--> statement-breakpoint
ALTER TABLE `links` ADD `led_team` text;