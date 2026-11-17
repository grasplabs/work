-- A team's claims and drawings rest only on the lines people chose to share
-- with their team as how they work (GRA-1987). Every one standing now was
-- drawn from lines that, with no choice made, are only counted anonymously.
-- Nothing is released (hard cut): each is owed its erasure, which core's
-- clock finishes, and a team's results stand again, from its shared lines
-- alone, at its next intake. Changes nothing run again.
UPDATE `brain_claims` SET `erase` = 1 WHERE `erase` = 0;--> statement-breakpoint
UPDATE `brain_drawings` SET `erase` = 1 WHERE `erase` = 0;
