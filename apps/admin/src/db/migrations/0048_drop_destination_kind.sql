-- One hosting destination per stage, always Workers for Platforms, so nothing reads a destination's kind.
ALTER TABLE `hosting_destinations` DROP COLUMN `kind`;
