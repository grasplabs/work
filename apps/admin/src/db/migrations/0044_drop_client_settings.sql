-- Nothing has written a client setting since feature flags went (#286): every deploy derives core's config, so the table goes.
DROP TABLE `settings`;
