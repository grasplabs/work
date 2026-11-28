-- The one-step deploy workflow is gone: a client a deploy run last held is held by a rollout the admin doesn't have, which reads as gone, and the next claim replaces.
-- contract: change values client_runs.kind: release 26.11.99 removed the last use
UPDATE `client_runs` SET `kind` = 'rollout' WHERE `kind` = 'deploy';