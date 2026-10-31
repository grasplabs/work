-- Releases no longer declare interface versions or schema ranges: a release is the build of main, and clients move between releases by rollout. Manifests imported before keep the field, which the strict manifest schema now refuses.
UPDATE `releases` SET `manifest` = json_remove(`manifest`, '$.compatibility') WHERE json_type(`manifest`, '$.compatibility') IS NOT NULL;
