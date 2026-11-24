-- Approvals of a binding kind no workflow has any more: `knowledge`, which
-- the Brain's `brain` binding replaced (#2190), and the `template` and
-- `operation` ones before it. Their targets are of no kind core reads
-- (`workflowBindingTargetSchema`), nothing is released (hard cut), and
-- none of them serves anything: removed, so every stored approval reads.
-- Changes nothing run again.
DELETE FROM `workflow_binding_approvals` WHERE `kind` NOT IN ('connector', 'model', 'decision', 'event', 'brain', 'files') OR json_extract(`target`, '$.kind') NOT IN ('connector', 'model', 'decision', 'event', 'brain', 'files');
