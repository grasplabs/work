-- A model call no longer waits for an App's share: only the client's or its person's.
DELETE FROM `workflow_model_waits` WHERE `waiting_for` = 'app';
