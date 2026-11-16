ALTER TABLE `teams` ADD `mapped_does` text;--> statement-breakpoint
-- What a team does, as a lead's map wrote it, was kept in `does` with what
-- the admin wrote (GRA-1748): the admin's pages never let them write it, so
-- a team whose map was drawn holds the map's words there. They move to
-- `mapped_does`, which staff alone read, so no member is given them as
-- the admin's. Changes nothing run again.
UPDATE `teams` SET `mapped_does` = `does`, `does` = '' WHERE `mapped_at` IS NOT NULL AND `does` <> '';
