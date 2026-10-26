ALTER TABLE `interview_states` ADD `revocations` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- A map's `mapped_from` is its lead's agreement's generation now,
-- `agreedAt|revocations`. A map drawn before its lead's last take-back
-- (`mapped_from < revoked_at`) stood on nothing then and stays so; any
-- other stood on every take-back there was, none counted yet.
UPDATE `teams` SET `mapped_from` = CASE
  WHEN EXISTS (SELECT 1 FROM `interview_states` AS `lead`
    WHERE `lead`.`person` = `teams`.`lead` AND `lead`.`revoked_at` IS NOT NULL
      AND `teams`.`mapped_from` < `lead`.`revoked_at`) THEN NULL
  ELSE `teams`.`mapped_from` || '|0' END
WHERE `mapped_from` IS NOT NULL;--> statement-breakpoint
-- What was drawn is kept as the generation it was drawn from too. Drawn
-- since the last agreement: drawn from that generation, no take-back
-- counted yet. Otherwise left a time, which is never a generation, so it
-- stays due.
UPDATE `interview_states` SET `drawn_at` = `agreed_at` || '|0'
WHERE `drawn_at` IS NOT NULL AND `agreed_at` IS NOT NULL AND `drawn_at` >= `agreed_at`;
