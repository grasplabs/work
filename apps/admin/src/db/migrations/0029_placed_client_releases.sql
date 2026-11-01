-- A placed client's later releases and rollbacks reuse its one operation
-- (src/hosting/operation.ts): the release it ran before the latest one
-- started, which a rollback takes it back to.
ALTER TABLE `client_provisions` ADD `previous_release_id` text REFERENCES releases(id);