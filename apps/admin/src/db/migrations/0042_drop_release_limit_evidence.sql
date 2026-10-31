ALTER TABLE `releases` DROP COLUMN `limit_evidence`;--> statement-breakpoint
ALTER TABLE `releases` DROP COLUMN `limit_evidence_sha256`;--> statement-breakpoint
-- Releases no longer record platform limits: manifests imported before keep the field, which the strict manifest schema now refuses.
UPDATE `releases` SET `manifest` = json_remove(`manifest`, '$.platformLimits') WHERE json_type(`manifest`, '$.platformLimits') IS NOT NULL;
