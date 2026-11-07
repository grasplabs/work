-- Apps no longer call each other's functions (GRA-1555): an App's
-- permission of the platform's own functions is `grasp`, and nothing
-- binds to another App. A binding to another App no longer parses or
-- serves, so it goes, revoked ones included; the audit log keeps what each
-- approval and call was.
DELETE FROM `app_resource_bindings` WHERE `kind` = 'app';
