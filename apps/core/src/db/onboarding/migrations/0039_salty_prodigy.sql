ALTER TABLE `teams` ADD `mapped_does` text;--> statement-breakpoint
-- What a team does, as a lead's map wrote it, was kept in `does` with what
-- the admin wrote (GRA-1748). A map wrote it every time it was drawn, also
-- when it didn't mark the team mapped (`mapped_at`), while no page or seed
-- ever let the admin write it: so every text there moves, failing closed,
-- to `mapped_does`, which staff alone read, so no member is given a map's
-- words as the admin's. Changes nothing run again.
UPDATE `teams` SET `mapped_does` = `does`, `does` = '' WHERE `does` <> '';
