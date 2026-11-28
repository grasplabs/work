-- A halted rollout says itself why nothing new deploys on its channel: nothing writes or reads the channel's copy since.
-- contract: drop column channels.stopped_by: release 26.11.99 removed the last use
ALTER TABLE `channels` DROP COLUMN `stopped_by`;