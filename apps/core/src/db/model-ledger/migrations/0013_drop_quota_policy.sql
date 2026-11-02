-- Quota limits are the platform's, in code (#1774): no admission carries a policy generation any more.
DROP TABLE `policy`;--> statement-breakpoint
ALTER TABLE `requests` DROP COLUMN `policy_generation`;