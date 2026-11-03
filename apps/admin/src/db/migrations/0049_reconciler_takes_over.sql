-- The reconciler takes over from rollout jobs: a client an old rollout or rollback last held is held by a deploy the admin doesn't have, which the next claim replaces.
UPDATE `client_runs` SET `kind` = 'deploy' WHERE `kind` IN ('rollout', 'rollback');
