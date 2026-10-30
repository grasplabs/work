// Where a person's data lives in core's databases, and what erasing them
// does to each place (GRA-903, GRA-1189; the inventory on GRA-903). Every
// table of every database is listed here, under one of:
//
// - `erased`: theirs alone, taken out by an erasure area (person-erasure.ts)
//   or by removing them first (`removal`, members.ts); `via` names the
//   table whose rows take its rows with them (a cascade);
// - `company`: the company's own record of what they did or own, kept with
//   their ID and frozen name (Nick's D1, D3, D5);
// - `kept`: a record that must stay: security, accounting, or the erasure's
//   own, IDs only (D2);
// - `none`: no person in it, with why when a column's name suggests one.
//
// A person hides in columns of every name (a JSON event, a scope's key),
// so every table is listed, not only those whose columns name a person: a
// new table fails the test (erasure-classification.test.ts) until someone
// decides what erasing a person does to it. @grasp-os/shared/person-columns
// is a hint on top: a table whose columns name a person can't be `noPerson`
// without saying why.

/** The erasure areas (person-erasure.ts), and removal before them. */
export const erasureAreas = [
  "removal",
  "identity",
  "channels",
  "connect",
  "workspace",
  "apps",
  "brain",
  "runs",
  "interview",
] as const;

/** What erasing a person does to a table that names one. */
export type ErasureClass =
  | {
      readonly erased: (typeof erasureAreas)[number];
      readonly via?: string;
    }
  | { readonly company: string }
  | { readonly kept: string }
  | { readonly none: string };

/** A table that holds no person at all. */
export const noPerson = { none: "holds no person" } as const;

/** Every table of core's and the Brain's databases, by `<database>.<table>`. */
export const erasureInventory: Readonly<Record<string, ErasureClass>> = {
  // Core's database.
  "core.users": { erased: "identity" },
  "core.sessions": { erased: "identity" },
  "core.accounts": { erased: "identity" },
  "core.members": { erased: "removal" },
  "core.member_removals": { kept: "keeps someone removed out" },
  "core.person_erasures": { kept: "the erasure's own record, by ID" },
  "core.person_erasure_areas": { kept: "the erasure's own record, by ID" },
  "core.erased_subjects": {
    kept: "keeps someone erased out, as keyed hashes of their sign-in subjects",
  },
  "core.channel_accounts": { erased: "channels" },
  "core.channel_links": { erased: "channels" },
  "core.channel_conversations": { erased: "channels" },
  "core.chat_workflow_offers": { erased: "channels" },
  // A shared chat's audience is the company's, but the rows of the chats
  // in their own workspace go with it.
  "core.chat_audiences": { erased: "workspace" },
  "core.invitations": { erased: "channels" },
  "core.teams": { none: "member_count is a count" },
  "core.team_members": { erased: "removal" },
  "core.sso_providers": { none: "stays empty: providers come from config" },
  "core.permissions": { company: "grants they asked for or gave" },
  "core.apps": { company: "Apps they own or changed" },
  "core.app_integrations": { company: "integrations they added" },
  "core.access_revocations": { kept: "revocations still to tell a host" },
  "core.app_members": { company: "who has a role in an App" },
  "core.screen_artifacts": { company: "screen code they approved" },
  "core.blueprints": { company: "blueprints they marked" },
  "core.app_versions": { company: "versions they wrote or proposed" },
  "core.app_candidates": { company: "candidates they made" },
  "core.sdk_artifact_deletions": { none: "owner is a deleting process" },
  "core.screen_submissions": { erased: "apps" },
  "core.action_invocations": { company: "actions run for them, as runs are" },
  "core.app_test_runs": { company: "test runs, deleted once they end" },
  "core.app_test_decisions": {
    company: "a test run's decisions, deleted with their run",
  },
  "core.resource_templates": { company: "templates they published" },
  "core.app_resource_bindings": { company: "bindings they approved" },
  "core.workflow_runs": { company: "runs they started (D3)" },
  "core.run_lineage_attempts": { kept: "accounting of a run's attempts" },
  "core.workflow_admission_queue": { kept: "admission, by ID" },
  "core.build_leases": { kept: "admission, by ID" },
  "core.build_admission_queue": { kept: "admission, by ID" },
  "core.workflow_model_waits": { kept: "a step's wait, gone once it stops" },
  "core.run_mail_stamps": { company: "mail a run sent (D3)" },
  "core.run_mail_calls": { company: "mail a run sent (D3)" },
  "core.resource_run_mail_calls": {
    company: "mail an independent workflow's run sent (D3)",
  },
  "core.workflow_run_controls": { company: "controls of runs (D3)" },
  "core.workflow_decisions": { company: "decisions they answered (D3)" },
  "core.workflow_decision_recipients": { company: "who a decision asked" },
  "core.workflow_decision_confirmations": { erased: "runs" },
  "core.dependency_requests": { company: "package requests and decisions" },
  "core.dependency_approvers": { company: "package approvers" },
  "core.dependency_locks": { none: "subject is an App or workflow" },
  "core.dependency_build_leases": { none: "subject is an App or workflow" },
  "core.dependency_admission_refusals": {
    none: "subject is an App or workflow",
  },
  "core.workflow_param_values": { company: "parameters they set" },
  "core.workflow_owners": { company: "workflows they own" },
  "core.hidden_connectors": { company: "connectors an admin hid" },
  "core.tool_class_settings": { company: "settings an admin changed" },
  "core.app_pointers": { company: "settings an admin changed" },
  "core.shared_mailbox_pointers": { company: "settings an admin changed" },
  "core.stephen_reach": { company: "settings an admin changed" },
  "core.stephen_places": { company: "settings an admin changed" },
  "core.app_tool_classes": { company: "settings an admin changed" },
  "core.app_requests": { company: "Apps they asked Grasp for" },
  "core.improvement_signals": { kept: "IDs and counts only" },
  "core.notifications": { erased: "channels" },
  "core.org_settings": {
    none: "the organization's billing and Pulse settings",
  },
  "core.policy_documents": { company: "policy documents they uploaded" },
  "core.policy_rules": { company: "policy rules they wrote" },
  "core.policy_exceptions": { company: "exceptions they granted" },
  "core.workflow_teams": { company: "the team they set as a workflow's owner" },
  "core.run_brain_evidence": {
    company: "what a run recalled, as runs are (D3)",
  },
  "core.guest_chats": { company: "guest chats they opened for an App" },
  "core.migration_samples": { company: "counts and codes only" },
  "core.business_stores": { company: "stores they created" },
  "core.business_store_members": { company: "who has a role in a store" },
  "core.workflow_resources": { company: "workflows they own" },
  "core.workflow_resource_versions": { company: "versions they wrote" },
  "core.workflow_resource_members": { company: "who has a role in a workflow" },
  "core.trigger_resources": { company: "triggers they own" },
  "core.trigger_resource_versions": { none: "a binding's name" },
  "core.trigger_schedules": noPerson,
  "core.workflow_start_receipts": { company: "runs started for them (D3)" },
  "core.workflow_resource_runs": { company: "runs for them (D3)" },
  "core.workflow_run_files": { company: "files of runs (D3)" },
  "core.workflow_emitted_events": { company: "events of runs (D3)" },
  "core.workflow_resource_run_controls": { company: "controls of runs (D3)" },
  "core.workflow_catalog_contracts": { company: "contracts they published" },
  "core.workflow_binding_approvals": { company: "bindings they approved" },
  "core.workflow_resource_params": { company: "parameters they set" },
  "core.workflow_resource_drafts": { company: "drafts of workflows" },
  "core.app_workflow_bindings": { company: "bindings they made" },
  "core.workflow_candidate_runs": { company: "candidate runs (D3)" },
  "core.landscape_app_people": { company: "the company's roster (D5)" },
  "core.landscape_staged_people": { company: "the company's roster (D5)" },
  "core.brain_gap_states": { company: "who answered a gap, by ID" },
  "core.uploads": { company: "Knowledge uploads; Personal ones the Brain's" },
  "core.knowledge_signals": { erased: "apps" },
  "core.knowledge_signal_dismissals": {
    none: "subject is a search or document",
  },
  "core.verifications": {
    kept: "a sign-in's state for its minutes, by a random identifier",
  },
  "core.audit_outbox": { kept: "audit events on their way to the log (D2)" },
  "core.audit_outbox_rejected": { kept: "audit events the log refused (D2)" },
  "core.brain_capture_intents": { company: "outcomes of runs (D3), by run" },
  "core.brain_records": {
    company: "agreed facts naming roles; a gap's answer names who gave it",
  },
  "core.guest_messages": { company: "guest chats they opened for an App" },
  "core.landscape_apps": { company: "the company's landscape of Apps (D5)" },
  "core.landscape_staged_apps": {
    company: "the company's landscape of Apps (D5)",
  },
  "core.app_statistics": { company: "an App's aggregates, by its dimensions" },
  "core.app_statistic_steps": {
    company: "an App's aggregates, by its dimensions",
  },
  "core.run_mail_stamp_claims": { company: "mail a run sent (D3), hashed" },
  "core.workflow_resource_draft_modules": { company: "drafts of workflows" },
  "core.workflow_resource_draft_inspections": {
    company: "drafts of workflows",
  },
  "core.workflow_run_file_chunks": { company: "files of runs (D3)" },
  "core.app_candidate_reports": noPerson,
  "core.app_default_stores": noPerson,
  "core.app_entries": noPerson,
  "core.app_origins": noPerson,
  "core.app_test_fixtures": noPerson,
  "core.build_commit_fences": noPerson,
  "core.build_receipts": noPerson,
  "core.business_store_versions": noPerson,
  "core.channel_signals": noPerson,
  "core.collection_teams": noPerson,
  "core.dependency_policy": noPerson,
  "core.improvement_signal_computations": noPerson,
  "core.jwks": noPerson,
  "core.knowledge_signal_computations": noPerson,
  "core.landscape_syncs": noPerson,
  "core.mail_domains": noPerson,
  "core.migration_sample_leases": noPerson,
  "core.onboarding_gate": noPerson,
  "core.organizations": noPerson,
  "core.package_cleanups": noPerson,
  "core.platform_versions": noPerson,
  "core.preview_fixture_stores": noPerson,
  "core.quota_policies": noPerson,
  "core.run_lineage_accounts": noPerson,
  "core.run_lineage_children": noPerson,
  "core.run_lineages": noPerson,
  "core.run_mail_stamp_refusals": noPerson,
  "core.screen_builds": noPerson,
  "core.screen_policies": noPerson,
  "core.sdk_artifact_candidates": noPerson,
  "core.sdk_release_artifacts": noPerson,
  "core.sdk_release_manifests": noPerson,
  "core.sdk_release_pins": noPerson,
  "core.sdk_release_tombstones": noPerson,
  "core.sdk_resource_bindings": noPerson,
  "core.sdk_store_owners": noPerson,
  "core.upload_cleanups": noPerson,
  "core.workflow_resource_run_control_keys": noPerson,
  "core.workflow_resource_run_terminations": noPerson,
  "core.workflow_run_wakes": noPerson,
  "core.workflow_triggers": noPerson,
  "core.workflow_item_tests": {
    company: "a workflow's test runs, by whom they ran as (D3)",
  },
  "core.workflow_resource_lifecycles": {
    company: "who approved, paused or asked to take a workflow live (D3)",
  },
  "core.workflow_resource_processes": {
    company: "who set the business process a workflow belongs to (D3)",
  },
  "core.connector_trigger_holds": {
    none: "a trigger's held events, by their keys",
  },
  // Their workspace: the object is theirs alone, emptied whole.
  "workspace.chats": { erased: "workspace" },
  "workspace.chat_projects": { erased: "workspace" },
  "workspace.dashboards": { erased: "workspace" },
  "workspace.custom_widgets": { erased: "workspace" },
  "workspace.dashboard_widgets": { erased: "workspace" },
  "workspace.email_preferences": { erased: "workspace" },
  "workspace.audit_outbox": { erased: "workspace" },
  "workspace.brain_capture_intents": { erased: "workspace" },
  "workspace.chat_attachments": { erased: "workspace" },
  "workspace.chat_build_jobs": { erased: "workspace" },
  "workspace.chat_code_runs": { erased: "workspace" },
  "workspace.chat_documents": { erased: "workspace" },
  "workspace.chat_draft_contents": { erased: "workspace" },
  "workspace.chat_draft_files": { erased: "workspace" },
  "workspace.chat_draft_version_files": { erased: "workspace" },
  "workspace.chat_draft_versions": { erased: "workspace" },
  "workspace.chat_drafts": { erased: "workspace" },
  "workspace.chat_messages": { erased: "workspace" },
  "workspace.chat_project_documents": { erased: "workspace" },
  "workspace.chat_run_sources": { erased: "workspace" },
  "workspace.chat_sources": { erased: "workspace" },
  "workspace.chat_tool_events": { erased: "workspace" },
  "workspace.preview_release_artifacts": { erased: "workspace" },
  "workspace.preview_releases": { erased: "workspace" },
  "workspace.preview_stores": { erased: "workspace" },
  // The onboarding: their interview, by its own deletion.
  "onboarding.people": { company: "the company's roster (D5)" },
  "onboarding.links": { erased: "interview" },
  "onboarding.link_codes": { erased: "interview" },
  "onboarding.interviews": { erased: "interview" },
  "onboarding.participations": { erased: "interview" },
  "onboarding.readbacks": { erased: "interview" },
  "onboarding.approvals": { erased: "interview" },
  "onboarding.interview_states": { erased: "interview" },
  "onboarding.interview_texts": { erased: "interview" },
  "onboarding.counted": { kept: "who was counted in the admin's numbers" },
  "onboarding.asked_about": { erased: "interview" },
  "onboarding.brain_sent": { erased: "interview" },
  "onboarding.interview_settings": { erased: "interview" },
  // The roster's and the onboarding's own: who did what, by ID (D5).
  "onboarding.teams": { company: "the company's roster: a team's lead (D5)" },
  "onboarding.works": { company: "the company's roster: who does what (D5)" },
  "onboarding.mail_outbox": {
    company: "mail to the roster (D5), which keeps the address anyway",
  },
  "onboarding.events": { kept: "the onboarding's log, IDs only" },
  "onboarding.counted_works": { company: "who counted a work (D5)" },
  "onboarding.documents": { company: "documents the admin shared" },
  "onboarding.kickoff": { company: "the kickoff, as staff brought it in" },
  "onboarding.notes": { none: "staff's own notes, by staff" },
  "onboarding.voice_use": { kept: "today's voice seconds, gone tomorrow" },
  "onboarding.audit_outbox": {
    kept: "audit events on their way to the log (D2)",
  },
  "onboarding.answer_waits": noPerson,
  "onboarding.brain_teams": noPerson,
  "onboarding.checked_differences": {
    company: "a team's difference five or more told each way, names out",
  },
  "onboarding.draw_failures": noPerson,
  "onboarding.drawn_works": noPerson,
  "onboarding.forget_lines": noPerson,
  "onboarding.onboarding": noPerson,
  "onboarding.settled_works": noPerson,
  "onboarding.team_counts": noPerson,
  "onboarding.usage": noPerson,
  // Each App's store.
  "dataStore.sdk_store": { none: "who deleted the store, a process" },
  "dataStore.sdk_records": { company: "the App's records they own (D1)" },
  "dataStore.sdk_abandoned_targets": { company: "migration work" },
  "dataStore.sdk_schema_backfills": { none: "a backfill's process" },
  "dataStore.sdk_migration_work": { company: "migration work" },
  "dataStore.sdk_mutation_receipts": { company: "writes of the App's records" },
  "dataStore.sdk_commit_writers": { company: "writes of the App's records" },
  "dataStore.sdk_files": { company: "the App's files they own" },
  "dataStore.sdk_file_delete_keys": { company: "the App's files they own" },
  "dataStore.sdk_preferences": { erased: "apps" },
  "dataStore.sdk_cascade_jobs": { company: "writes of the App's records" },
  "dataStore.sdk_cascade_members": noPerson,
  "dataStore.sdk_file_chunks": noPerson,
  "dataStore.sdk_file_refs": noPerson,
  "dataStore.sdk_record_refs": noPerson,
  "dataStore.sdk_reserved_fields": noPerson,
  "dataStore.sdk_schema_activations": noPerson,
  "dataStore.sdk_schemas": noPerson,
  "dataStore.sdk_tables": noPerson,
  "dataStore.sdk_change_outbox": { company: "writes of the App's records" },
  "dataStore.sdk_file_events": { company: "the App's files they own" },
  "dataStore.sdk_file_writes": { company: "the App's files they own" },
  // The Brain and Knowledge (the Brain's personal purge erases a person's
  // own; what they wrote in the company's collections is the company's).
  "brain.collections": {
    company: "collections; their Personal one the Brain's",
  },
  "brain.documents": { company: "documents; their Personal ones the Brain's" },
  "brain.versions": { company: "versions; their Personal ones the Brain's" },
  "brain.brain_memories": { erased: "brain" },
  "brain.brain_episodes": { erased: "brain" },
  "brain.brain_episode_members": { erased: "brain" },
  "brain.brain_lessons": { erased: "brain" },
  "brain.brain_lesson_versions": { erased: "brain", via: "brain_lessons" },
  "brain.brain_lesson_evidence": { erased: "brain", via: "brain_episodes" },
  "brain.brain_memory_cites": { erased: "brain", via: "brain_memories" },
  "brain.brain_receipts": { erased: "brain" },
  "brain.brain_consolidation_marks": { erased: "brain" },
  "brain.brain_consolidation_due": { erased: "brain" },
  "brain.brain_entities": {
    company: "what documents name; those only their records name go",
  },
  "brain.brain_entity_keys": { company: "keys of entities, with them" },
  "brain.brain_mentions": { company: "names in documents, with them" },
  "brain.brain_assertions": {
    company: "relations documents state; their memories' go with them",
  },
  "brain.brain_link_jobs": { company: "links of documents, with them" },
  "brain.sections": { company: "documents; their Personal ones the Brain's" },
  "brain.transcripts": {
    company: "documents; their Personal ones the Brain's",
  },
  "brain.brain_payloads": { company: "uploads; their Personal ones go" },
  "brain.brain_erased_evidence": { kept: "IDs of evidence erased" },
  "brain.audit_outbox": { kept: "audit events on their way to the log (D2)" },
  "brain.audit_outbox_rejected": { kept: "audit events the log refused (D2)" },
  "brain.brain_capture_cursors": noPerson,
  "brain.brain_payload_releases": noPerson,
  "brain.brain_sequences": noPerson,
  "brain.links": noPerson,
  "brain.search_rebuilds": noPerson,
  "brain.brain_forgotten_people": {
    kept: "keeps their memory from coming back",
  },
  // The model ledger.
  "modelLedger.requests": { kept: "accounting, by ID" },
  "modelLedger.queue": { kept: "accounting, by ID" },
  "modelLedger.person_limits": { erased: "runs" },
  // Spend is accounted by ID: a person's scope is keyed and named by their
  // user ID, never their name or address.
  "modelLedger.request_scopes": { kept: "accounting, by ID, swept with it" },
  "modelLedger.spend": { kept: "accounting, by ID" },
  "modelLedger.alerts": { kept: "alerts sent, by ID" },
  "modelLedger.audit_outbox": {
    kept: "audit events on their way to the log (D2)",
  },
  "modelLedger.policy": noPerson,
  // The audit log: IDs only, never rewritten, archived for 7 years (D2).
  "auditLog.events": { kept: "the audit log (D2)" },
  "auditLog.archives": noPerson,
};
