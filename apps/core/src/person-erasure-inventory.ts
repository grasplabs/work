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
// - `expires`: a person's data with no key that names them (an outside
//   system's event, say), so erasure can't find their rows: core deletes
//   every row on its own within a bounded window, and erasure relies on
//   that, with why;
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
  "brain_shared",
  "identity",
  "channels",
  "connect",
  "workspace",
  "apps",
  "brain",
  "runs",
  "interview",
  "brain_sources",
] as const;

/** An area of a person's erasure (person-erasure.ts): one of `erasureAreas` but removal. */
export type ErasureAreaName = Exclude<(typeof erasureAreas)[number], "removal">;

/** What erasing a person does to a table that names one. */
export type ErasureClass =
  | {
      readonly erased: (typeof erasureAreas)[number];
      readonly via?: string;
    }
  | { readonly company: string }
  | { readonly kept: string }
  | { readonly expires: string }
  | { readonly none: string };

/** A table that holds no person at all. */
export const noPerson = { none: "holds no person" } as const;

/** Every table of core's and the Brain's databases, by `<database>.<table>`. */
export const erasureInventory: Readonly<Record<string, ErasureClass>> = {
  // Core's database.
  "core.users": { erased: "identity" },
  "core.sessions": { erased: "identity" },
  "core.accounts": { erased: "identity" },
  // The token the Brain knows each account on a copied reader list by
  // (source-readers.ts): a person's accounts' rows go with their accounts.
  // An outsider's stay, the company's record of who its documents were
  // shared with: telling whether a stored list still names one would take
  // a read of the Brain's sets.
  "core.source_reader_tokens": { erased: "identity" },
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
  "core.projects": { company: "projects they made" },
  "core.project_members": { company: "who is in a project" },
  "core.project_items": { company: "what they filed in a project" },
  "core.blueprints": { company: "blueprints they marked" },
  "core.app_versions": { company: "versions they wrote or published" },
  "core.app_drafts": { company: "drafts of Apps they wrote" },
  "core.app_draft_files": { company: "drafts of Apps they wrote" },
  "core.app_draft_points": { company: "drafts of Apps they wrote" },
  "core.app_draft_point_files": { company: "drafts of Apps they wrote" },
  "core.app_draft_contents": { company: "drafts of Apps they wrote" },
  "core.drafts": { company: "drafts of Apps and workflows they wrote" },
  "core.draft_files": { company: "drafts of Apps and workflows they wrote" },
  "core.draft_checkpoints": {
    company: "drafts of Apps and workflows they wrote",
  },
  "core.draft_checkpoint_files": {
    company: "drafts of Apps and workflows they wrote",
  },
  "core.draft_blobs": { company: "drafts of Apps and workflows they wrote" },
  "core.app_candidates": { company: "candidates they made" },
  "core.sdk_artifact_deletions": { none: "owner is a deleting process" },
  "core.action_invocations": { company: "actions run for them, as runs are" },
  "core.app_test_runs": { company: "test runs, deleted once they end" },
  "core.app_test_decisions": {
    company: "a test run's decisions, deleted with their run",
  },
  "core.resource_templates": { company: "templates they published" },
  "core.app_resource_bindings": { company: "bindings they approved" },
  "core.workflow_runs": { company: "runs they started (D3)" },
  "core.run_lineage_attempts": { kept: "accounting of a run's attempts" },
  "core.build_leases": { kept: "admission, by ID" },
  "core.workflow_model_waits": { kept: "a step's wait, no longer written" },
  // Spend is recorded by ID: a person's usage is keyed by their user ID,
  // never their name or address.
  "core.model_usage": { kept: "accounting, by ID" },
  "core.provider_health": noPerson,
  "core.run_mail_stamps": { company: "mail a run sent (D3)" },
  "core.run_inboxes": noPerson,
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
  "core.hidden_connectors": { company: "connectors an admin hid" },
  "core.tool_class_settings": { company: "settings an admin changed" },
  "core.app_pointers": { company: "settings an admin changed" },
  "core.shared_mailbox_pointers": { company: "settings an admin changed" },
  "core.connection_brain_audiences": { company: "settings an admin changed" },
  // What agents read through a shared connection, kept for its audience,
  // names no one; who asked to erase it, an admin's act on the company's.
  "core.connection_brain_reads": noPerson,
  "core.connection_brain_erasures": { company: "erasures an admin asked for" },
  "core.stephen_reach": { company: "settings an admin changed" },
  "core.stephen_places": { company: "settings an admin changed" },
  "core.app_tool_classes": { company: "settings an admin changed" },
  // Their own agents (`owner_id`), with those agents' documents. The
  // company's agents, and what an admin gave them, stay the company's.
  "core.agents": { erased: "workspace" },
  "core.agent_documents": { erased: "workspace" },
  // Their own agents' apps; a company agent's, which a person set, stay.
  "core.agent_apps": { erased: "workspace" },
  "core.agent_reach": { company: "settings an admin changed" },
  "core.agent_wakes": { erased: "workspace" },
  "core.agent_places": { company: "settings an admin changed" },
  "core.agent_tool_classes": { company: "settings an admin changed" },
  "core.app_requests": { company: "Apps they asked Grasp for" },
  // Their asks to share a skill (a waiting one holds their text) are
  // deleted; on asks they decided as an admin, `decided_by` is cleared,
  // and the decision stays.
  "core.skill_shares": { erased: "brain" },
  // Admins' decisions on the company's and the teams' skills, with the
  // text each decided: the company's, and what the Brain follows, so they
  // stay. Who decided (`decided_by`) is cleared when that admin is erased.
  // Their audience (`audience`) names the company or a team, never a person.
  "core.skill_decisions": {
    company:
      "decisions on the company's and the teams' skills, unnamed once their decider is erased",
  },
  // The names of the skills they deleted for good: theirs alone.
  "core.skill_deletions": { erased: "brain" },
  "core.improvement_signals": { kept: "IDs and counts only" },
  "core.notifications": { erased: "channels" },
  // What they asked Stephen, with where their weekly summary stood.
  "core.stephen_requests": { erased: "channels" },
  "core.stephen_request_cards": { erased: "channels" },
  "core.stephen_summaries": { erased: "channels" },
  "core.stephen_summary_readers": { erased: "channels" },
  "core.stephen_request_needs": {
    company: "what an owner or admin did about something Needs you lists",
  },
  "core.agent_held_starts": { erased: "workspace" },
  "core.preview_fixture_stores": {
    none: "nothing writes or reads it; dropped by the next contract migration",
  },
  // A source is a pin (history-access.ts): a memory's pin names other
  // people by ID, its writer and the person whose word it is. Their
  // erasure removes neither; the IDs stay, as the company's records keep
  // an erased person's ID (D3).
  "core.run_chat_sources": {
    company:
      "what a run's chat had read, with the run; its pins keep other people's IDs after their erasure (D3)",
  },
  "core.org_settings": {
    none: "the organization's billing and Pulse settings",
  },
  // Written only by an older core (rows from before, or during a rollout or
  // after a rollback), and removed with the run by retention until a later
  // contract migration drops it; this entry goes with the table.
  "core.run_brain_evidence": {
    company: "what a run recalled, as runs are (D3)",
  },
  "core.run_brain_versions": {
    company:
      "which Brain versions a run recalled, identifiers only, as runs are (D3)",
  },
  "core.run_brain_memories": {
    company:
      "which Brain memories a run's entity reads rested on, identifiers only, no person's, as runs are (D3)",
  },
  "core.guest_chats": { company: "guest chats they opened for an App" },
  // An App's visitor list (app-visitors.ts): the company's, as its builders
  // keep it, with the builder who listed each entry (`added_by`). An entry
  // may be a member's own address; it stays, the list's to change, never
  // the erasure's (a decision for Nick: see the PR).
  "core.app_visitor_entries": {
    company: "an App's visitor list, and the builder who listed each",
  },
  // The App functions a version grants its visitors (app-visitor-grants.ts),
  // with the builder who granted each (`granted_by`): the App's own
  // settings, as other settings a builder changed are.
  "core.app_visitor_grants": {
    company: "the functions builders granted an App's visitors",
  },
  // A visitor's codes and sessions name them only by address, mostly an
  // outside visitor's, and are short-lived: a code works 10 minutes and
  // its row goes an hour after, a session lasts 8 hours at most, and the
  // sweep deletes both. A member's own address may be listed (or their
  // domain), so the rows under the address that was theirs go with their
  // email, in the identity area's batch.
  "core.app_visitor_codes": { erased: "identity" },
  "core.app_visitor_sessions": { erased: "identity" },
  // An App's webhooks (app-webhooks.ts): the company's settings, naming
  // the builder who added each and the admin who approved its URL, as
  // other settings name who changed them.
  "core.app_webhooks": {
    company: "webhooks builders added, and the admins who approved them",
  },
  // A delivery of a form names who sent it, and carries what they sent
  // until it settles: theirs go, waiting or not, with none queued after.
  // Those of a publish or a version made current name nobody.
  "core.app_webhook_deliveries": { erased: "apps" },
  // Which forms were told, by a hash of who sent each with the rest
  // (app-webhook-queue.ts), so none is told twice; forgotten once no
  // repeat can come. Erasing one would tell a repeat again.
  "core.app_form_submissions": {
    kept: "which forms were told, as hashes, forgotten once no repeat can come",
  },
  "core.business_stores": { company: "stores they created" },
  "core.business_store_members": { company: "who has a role in a store" },
  "core.workflow_resources": { company: "workflows they own" },
  "core.workflow_resource_versions": { company: "versions they wrote" },
  "core.workflow_resource_members": { company: "who has a role in a workflow" },
  "core.trigger_resources": { company: "triggers they own" },
  "core.event_sources": { company: "event sources an admin created" },
  "core.event_waits": { none: "runs' waits, by run and hash" },
  // An outside system's events may name people anywhere in their data,
  // under no key of ours: erasing a person can't find them, so each is
  // deleted within a day (workflows/event-waits.ts), and with its source.
  "core.kept_events": {
    expires:
      "an outside system's events, which may name people; deleted within 24 hours",
  },
  "core.kept_event_keys": {
    expires:
      "hashes of a kept event's values; deleted with it, within 24 hours",
  },
  "core.kept_event_takes": {
    none: "which run took a kept event; deleted with it",
  },
  "core.trigger_resource_versions": { none: "a binding's name" },
  "core.trigger_schedules": noPerson,
  "core.trigger_hour_slots": noPerson,
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
  "core.brain_gap_states": { company: "who answered a gap, by ID" },
  "core.brain_uploads": {
    company:
      "who uploaded which file into the Brain for a team or everyone, by ID and the file's name; their uploads for themselves alone, by ID with no name, go with brain_sources once the Brain erased them; a file's text is the Brain's",
  },
  "core.uploads": { erased: "brain" },
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
  // What core has still to hand over to the new Brain, by a source's kind
  // and id, until its hand-over ends. A chat turn's id names its person
  // (`<person>/<chat>/<answer>`); a run's names nobody. Their erasure ends
  // their open ones as erased once the Brain erased what was theirs
  // (person-erasure.ts, brain-sources.ts `endHandOversOf`), also one whose
  // item the queue parked for good.
  "core.brain_hand_overs": { erased: "brain_sources" },
  // Whose run results the Brain holds by workflow, and when each was taken
  // out of use as they lost it (brain-run-sources.ts): IDs and a count, as
  // the runs themselves are the company's.
  "core.brain_run_sources": {
    company: "whose run results it took out of use, by workflow (D3)",
  },
  // A person's own Brain store's health, keyed by the SHA-256 of their ID:
  // removed once the Brain's erasure erased their store (brain-next.ts
  // `erasePerson`).
  "core.brain_own_stores": { erased: "brain_sources" },
  "core.brain_records": {
    company: "agreed facts naming roles; a gap's answer names who gave it",
  },
  "core.guest_messages": { company: "guest chats they opened for an App" },
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
  "core.build_receipts": noPerson,
  "core.business_store_versions": noPerson,
  "core.channel_signals": noPerson,
  "core.dependency_policy": noPerson,
  "core.improvement_signal_computations": noPerson,
  "core.jwks": noPerson,
  "core.knowledge_signal_computations": noPerson,
  "core.mail_domains": noPerson,
  "core.onboarding_gate": noPerson,
  "core.organizations": noPerson,
  "core.package_cleanups": noPerson,
  "core.platform_versions": noPerson,
  "core.run_lineage_accounts": noPerson,
  "core.run_lineage_children": noPerson,
  "core.run_lineages": noPerson,
  "core.run_mail_stamp_refusals": noPerson,
  "core.screen_policies": noPerson,
  "core.sdk_artifact_candidates": noPerson,
  "core.sdk_artifact_refs": noPerson,
  "core.sdk_artifacts": noPerson,
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
  "core.admin_commands": noPerson,
  "core.brain_team_group_saves": noPerson,
  "core.brain_team_groups": noPerson,
  // Never written; GRA-1589 drops it.
  "core.run_evidence_holds": noPerson,
  "core.stephen_request_proposals": noPerson,
  "core.stephen_request_questions": {
    none: "Grasp's own wording, without names or details",
  },
  "core.stephen_request_topics": {
    none: "Grasp's own wording, without names or details",
  },
  "core.workflow_ai_waits": noPerson,
  // Nothing writes it since GRA-1552; dropped in GRA-1613.
  "core.workflow_stores": noPerson,
  "core.workflow_state": {
    company: "what a workflow keeps between its runs, as their outputs (D3)",
  },
  "core.workflow_state_writes": noPerson,
  "core.workflow_state_snapshots": {
    company: "what a workflow kept between its runs, as its runs froze it (D3)",
  },
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
  // Their workspace: the object is theirs alone, emptied whole. So is each
  // chat's `ChatSession` object (chat-session.ts), the chat's transcript as
  // pi-durable keeps it in tables of its own (`pi_`, no schema of ours):
  // the workspace area erases every one of its chats' (`erasePerson`).
  "workspace.chats": { erased: "workspace" },
  "workspace.dashboards": { erased: "workspace" },
  "workspace.custom_widgets": { erased: "workspace" },
  "workspace.dashboard_widgets": { erased: "workspace" },
  "workspace.audit_outbox": { erased: "workspace" },
  "workspace.brain_capture_intents": { erased: "workspace" },
  "workspace.chat_build_jobs": { erased: "workspace" },
  "workspace.chat_code_runs": { erased: "workspace" },
  "workspace.chat_documents": { erased: "workspace" },
  "workspace.chat_draft_contents": { erased: "workspace" },
  "workspace.chat_draft_files": { erased: "workspace" },
  "workspace.chat_draft_version_files": { erased: "workspace" },
  "workspace.chat_draft_versions": { erased: "workspace" },
  "workspace.chat_drafts": { erased: "workspace" },
  "workspace.chat_files": { erased: "workspace" },
  "workspace.chat_messages": { erased: "workspace" },
  // Its person's alone, erased with their workspace. A memory's pin also
  // names other people by ID (its writer, the person whose word it is):
  // their erasure removes neither, and the IDs stay in this person's chat,
  // as the company's records keep an erased person's ID (D3).
  "workspace.chat_run_sources": { erased: "workspace" },
  "workspace.chat_search_text": { erased: "workspace" },
  "workspace.chat_sources": { erased: "workspace" },
  "workspace.chat_tool_events": { erased: "workspace" },
  "workspace.held_app_calls": { erased: "workspace" },
  "workspace.memory_uses": { erased: "workspace" },
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
  "onboarding.counted": { kept: "who was counted in the admin's numbers" },
  "onboarding.asked_about": { erased: "interview" },
  "onboarding.brain_sent": { erased: "interview" },
  "onboarding.interview_settings": { erased: "interview" },
  // An interview's (`link:<person>`) go with it; an admin's
  // (`admin:<user>`), hashes of what the voice said for them, go with
  // the interview area too (person-erasure.ts).
  "onboarding.spoken_keys": { erased: "interview" },
  // What the new Brain holds of their interview, until its erasure there
  // returned.
  "onboarding.brain_interviews": { erased: "interview" },
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
  "onboarding.voice_use": { kept: "today's voice seconds, gone tomorrow" },
  "onboarding.audit_outbox": {
    kept: "audit events on their way to the log (D2)",
  },
  "onboarding.brain_teams": noPerson,
  "onboarding.brain_claims": {
    company: "how a team works, as its people shared it, names out",
  },
  "onboarding.brain_drawings": {
    company: "a team's work as its people shared it, names out",
  },
  "onboarding.checked_differences": {
    company: "a team's difference as its people told each way, names out",
  },
  "onboarding.draw_failures": noPerson,
  "onboarding.drawn_works": noPerson,
  "onboarding.forget_lines": noPerson,
  "onboarding.onboarding": noPerson,
  "onboarding.settled_works": noPerson,
  "onboarding.team_counts": noPerson,
  "onboarding.usage": noPerson,
  "onboarding.referrals": { erased: "interview" },
  "onboarding.more_voices": {
    none: "work to hear more about; who asked is the audit log's",
  },
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
  // A store's change history (store-changes.ts): the values of changes
  // made for or by them go with their erasure (`forgetPerson`); who acted,
  // when and which fields changed stay, the company's record of its
  // records' writes.
  "dataStore.sdk_record_changes": { erased: "apps" },
  // An import's rows waiting to land (store-host.ts, `stageImport`): theirs
  // go with their erasure, and every one an hour after it was staged.
  "dataStore.sdk_import_rows": { erased: "apps" },
  // A migration's output, staged while its publish runs (store-host.ts,
  // `stageMigration`): the App's records as they will be, gone as the
  // schema applies or the next migration begins.
  "dataStore.sdk_migration_rows": {
    company: "the App's records, as a migration rewrites them",
  },
  "dataStore.sdk_cascade_jobs": { company: "writes of the App's records" },
  "dataStore.sdk_cascade_members": noPerson,
  "dataStore.sdk_file_chunks": noPerson,
  "dataStore.sdk_file_refs": noPerson,
  "dataStore.sdk_record_refs": noPerson,
  "dataStore.sdk_reserved_fields": noPerson,
  // The resource, version and schema whose rules the store owes.
  "dataStore.sdk_rules_owed": noPerson,
  "dataStore.sdk_schema_activations": noPerson,
  "dataStore.sdk_schemas": noPerson,
  // Record IDs and the number each has in the search indexes. The indexes
  // themselves (`sdk_fts_*`, store-search.ts) are no Drizzle tables: they
  // hold a copy of `sdk_records`' text fields, kept in step by triggers
  // with secure-delete, so erasing or changing a record erases its text
  // there in the same write.
  "dataStore.sdk_search_docs": noPerson,
  "dataStore.sdk_tables": noPerson,
  // A form's values (app.form_sent) wait here only to reach the App's
  // webhooks: cleared once handed over, and with their sender's erasure
  // (`forgetPerson`), so what stays is the company's.
  "dataStore.sdk_change_outbox": {
    company: "writes of the App's records; a form's values go once handed over",
  },
  "dataStore.sdk_file_events": { company: "the App's files they own" },
  "dataStore.sdk_file_writes": { company: "the App's files they own" },
  // The audit log: IDs only, never rewritten, archived for 7 years (D2).
  "auditLog.events": { kept: "the audit log (D2)" },
  "auditLog.archives": noPerson,
  // The new Brain's shared store (@grasp-os/brain-next): what a team, the
  // company, an App's users or a staff-list team may read, or nobody.
  // Erasing a member removes what the Brain derived about them and what is
  // in their own word, and keeps the company's documents, even where their
  // text names them (decided 16 November, GRA-1747): `brain_shared`
  // (brain-next.ts `erasePersonShared`; the Brain's people.ts). What one
  // person alone may read is never here (the store refuses it,
  // store.ts `#mayKeep`): it is in their own store, the same tables, which
  // their erasure deletes whole (`brain_sources`, brain-next.ts
  // `erasePerson`), its record in R2 read before the store answers
  // anything, so a restore brings nothing back; so a person's own store
  // needs no entry here. The word indexes (migrations, not in the schema)
  // hold the words of these passages and memories, and go with them.
  // A set copied from where a document lives names each reader's account
  // (source-readers.ts, GRA-1761): an Entra object ID, or a Google
  // address. Kept with the document, as its text is; taking an erased
  // person's accounts out of these sets is still to be built (GRA-1761).
  "brainStore.reader_sets": {
    company: "who a document is shared with, by account, where it lives",
  },
  "brainStore.reader_set_members": {
    company: "who a document is shared with, by account, where it lives",
  },
  "brainStore.files": noPerson,
  "brainStore.source_versions": {
    company: "documents a team or more may read, even where they name them",
  },
  "brainStore.current_versions": { company: "the current version of each" },
  "brainStore.removed_sources": {
    company: "documents taken out of use, kept as history",
  },
  "brainStore.source_changes": {
    company: "the change keys of each add, as its producer named them",
  },
  "brainStore.source_subjects": {
    kept: "SHA-256 of each source's key, as the erasure ledger names it",
  },
  "brainStore.known_groups": {
    kept: "SHA-256 of each key named a group, so an erased group stays closed",
  },
  "brainStore.chunks": { company: "passages of those documents" },
  "brainStore.chunk_days": {
    company: "the days passages of those documents mention",
  },
  "brainStore.chunk_blocks": noPerson,
  "brainStore.vector_models": noPerson,
  "brainStore.vector_blocks": { company: "vector codes of those passages" },
  "brainStore.vector_codes": { company: "vector codes of those passages" },
  "brainStore.vector_removed": noPerson,
  "brainStore.vector_files": noPerson,
  "brainStore.embedding_state": noPerson,
  "brainStore.unembeddable": noPerson,
  "brainStore.work_items": {
    company:
      "work on those documents; a drawing names whose word a version is, by ID, and leaves out what is in an erased person's",
  },
  "brainStore.work_model_bucket": noPerson,
  "brainStore.word_index": noPerson,
  "brainStore.erasures": {
    kept: "the erasure ledger's record: SHA-256 of a source's key, a writer's lineage or an erased person's id (D2)",
  },
  "brainStore.erasing_versions": { kept: "erasures under way, by row" },
  "brainStore.erased_versions": {
    kept: "what an older release's erasure hid, by SHA-256 of a source's key",
  },
  "brainStore.person_erasure_subjects": {
    kept: "what a person's erasure closed: their address by SHA-256, closed for good, and their card by its id",
  },
  // SHA-256 of the identifiers of the person cards a restore's export
  // gives: a person's erasure deletes the rows of theirs, after taking the
  // cards by them (people.ts `applyPerson`); the rest go once the restore
  // is done, or, given up, with each card the store holds (forget.ts).
  "brainStore.restore_cards": { erased: "brain_shared" },
  "brainStore.person_erasure_memories": {
    kept: "the memories a person's erasure hides until the tick deletes them, by row",
  },
  "brainStore.exports": {
    company:
      "exports an admin asked for; one started before a member's erasure is stale",
  },
  "brainStore.export_parts": noPerson,
  "brainStore.export_sources": {
    company: "the versions each export holds, by SHA-256 of a source's key",
  },
  "brainStore.export_sweep": noPerson,
  "brainStore.restores": noPerson,
  // The person entity that is them alone (by the address they signed in
  // with), the memories about it or in their word, and the names those
  // gave; on anyone else's entity (a team, a project, a shared desk) their
  // address alone.
  "brainStore.entities": { erased: "brain_shared" },
  "brainStore.memories": { erased: "brain_shared" },
  "brainStore.entity_names": { erased: "brain_shared" },
  // Their confirmations stand, their id replaced (`erasedConfirmer`).
  "brainStore.memory_confirmations": { erased: "brain_shared" },
  "brainStore.memory_confirmed_over": noPerson,
  "brainStore.memory_extractions": {
    company: "marks of the versions fully drawn from",
  },
  // Which prompt versions (hashes) and models drew memories: no content.
  "brainStore.extractors": noPerson,
  "brainStore.memory_changes": {
    kept: "SHA-256 of change keys and ids, so an erased add is never made again",
  },
  "brainStore.memory_erase_failures": noPerson,
  "brainStore.memory_erasure_replay": noPerson,
  "brainStore.memory_stamps": noPerson,
  "brainStore.memory_outs": noPerson,
  "brainStore.memory_ins": noPerson,
  "brainStore.memory_judging": noPerson,
  "brainStore.memory_judging_places": noPerson,
  "brainStore.own_entity": {
    none: "a person's own store's entity for its person (own-entity.ts): the shared store holds none, and their own store is erased whole",
  },
};

/**
 * The columns of each table that name or hold a person
 * (@grasp-os/shared/person-columns), as they were reviewed when the table
 * was classified above; a table with none isn't listed. A column added to
 * a table already classified fails the test until it is listed here, and
 * whether the table's classification still holds for it is decided then.
 */
export const reviewedPersonColumns: Readonly<
  Record<string, readonly string[]>
> = {
  "brainStore.erased_versions": ["subject"],
  "brainStore.erasures": ["subject"],
  "brainStore.export_sources": ["subject"],
  "brainStore.known_groups": ["subject"],
  "brainStore.memories": ["speaker", "subject", "writer", "writer_subject"],
  "brainStore.memory_confirmations": ["person"],
  "brainStore.memory_extractions": ["subject"],
  "brainStore.person_erasure_subjects": ["subject"],
  "brainStore.restore_cards": ["subject"],
  "brainStore.reader_set_members": ["principal"],
  "brainStore.removed_sources": ["subject"],
  "brainStore.source_subjects": ["group_subject", "subject"],
  "core.access_revocations": ["user_ids"],
  "core.accounts": ["user_id", "verified_email"],
  "core.action_invocations": ["person_id"],
  "core.agent_held_starts": ["person_id"],
  "core.agents": ["changed_by", "made_by", "owner_id"],
  "core.agent_documents": ["added_by"],
  "core.agent_apps": ["changed_by"],
  "core.agent_places": ["changed_by"],
  "core.agent_reach": ["changed_by"],
  "core.agent_wakes": ["changed_by", "made_by", "person_id"],
  "core.agent_tool_classes": ["changed_by"],
  "core.app_candidates": ["created_by"],
  "core.app_draft_points": ["person_id"],
  "core.app_drafts": ["updated_by"],
  "core.app_integrations": ["added_by"],
  "core.app_members": ["added_by", "member_id", "member_type"],
  "core.app_pointers": ["changed_by"],
  "core.app_requests": ["requested_by"],
  "core.skill_shares": ["decided_by", "requested_by"],
  "core.skill_decisions": ["decided_by"],
  "core.skill_deletions": ["person_id"],
  "core.app_resource_bindings": ["approved_by", "revoked_by"],
  "core.app_test_decisions": ["decided_by", "recipients"],
  "core.app_test_runs": ["deciders", "principal"],
  "core.app_tool_classes": ["changed_by"],
  "core.app_versions": ["author_id", "proposed_by"],
  "core.app_visitor_entries": ["added_by"],
  "core.app_visitor_grants": ["granted_by"],
  "core.app_webhook_deliveries": ["person_id"],
  "core.app_webhooks": ["approved_by", "created_by"],
  "core.app_workflow_bindings": ["bound_by", "removed_by"],
  "core.apps": ["archived_by", "owner_id", "removed_by", "status_changed_by"],
  "core.blueprints": ["marked_by"],
  "core.brain_gap_states": ["answered_by"],
  "core.business_store_members": ["added_by", "member_id", "member_type"],
  "core.brain_run_sources": ["person_id"],
  "core.brain_uploads": ["uploaded_by"],
  "core.business_stores": ["closing_owner", "owner_id"],
  "core.channel_accounts": ["platform_user_id", "user_id"],
  "core.channel_conversations": ["user_id"],
  "core.channel_links": ["platform_user_id", "used_by"],
  "core.chat_audiences": ["members"],
  "core.chat_workflow_offers": ["user_id"],
  "core.connection_brain_audiences": ["changed_by"],
  "core.connection_brain_erasures": ["actor"],
  "core.dependency_admission_refusals": ["subject_id", "subject_type"],
  "core.dependency_approvers": [
    "granted_by",
    "revoked_by",
    "subject_id",
    "subject_type",
  ],
  "core.dependency_build_leases": ["subject_id", "subject_type"],
  "core.dependency_locks": ["subject_id", "subject_type"],
  "core.dependency_requests": [
    "decided_by",
    "ended_by",
    "requested_by",
    "subject_id",
    "subject_type",
  ],
  // A draft's subject is the App or workflow it drafts, never a person.
  "core.draft_blobs": ["subject_id", "subject_kind"],
  "core.draft_checkpoint_files": ["subject_id", "subject_kind"],
  "core.draft_checkpoints": ["person_id", "subject_id", "subject_kind"],
  "core.draft_files": ["subject_id", "subject_kind"],
  "core.drafts": ["subject_id", "subject_kind", "updated_by"],
  "core.erased_subjects": ["subject_hash", "user_id"],
  "core.event_sources": ["created_by"],
  "core.guest_chats": ["invited_by"],
  "core.hidden_connectors": ["hidden_by"],
  "core.improvement_signals": ["subject"],
  "core.invitations": ["email", "inviter_id"],
  "core.knowledge_signal_dismissals": ["subject"],
  "core.knowledge_signals": ["owner", "subject"],
  "core.member_removals": ["user_id"],
  "core.members": ["user_id"],
  "core.notifications": ["person_id"],
  "core.permissions": [
    "granted_by",
    "requested_by",
    "revoked_by",
    "subject_id",
    "subject_type",
  ],
  "core.person_erasure_areas": ["user_id"],
  "core.person_erasures": [
    "email_hash",
    "email_key_version",
    "requested_by",
    "user_id",
  ],
  "core.preview_fixture_stores": ["person_id"],
  "core.project_items": ["added_by"],
  "core.project_members": ["added_by", "member_id", "member_type"],
  "core.projects": ["owner_id"],
  "core.resource_run_mail_calls": ["recipients", "senders"],
  "core.resource_templates": ["published_by"],
  "core.run_chat_sources": ["person_id"],
  "core.run_mail_calls": ["recipients", "senders"],
  "core.run_mail_stamps": ["senders"],
  "core.sdk_artifact_deletions": ["owner"],
  "core.sessions": ["user_agent", "user_id"],
  "core.shared_mailbox_pointers": ["changed_by"],
  "core.sso_providers": ["user_id"],
  "core.stephen_places": ["changed_by"],
  "core.stephen_reach": ["changed_by"],
  "core.stephen_request_needs": ["status_by"],
  "core.stephen_requests": ["person_id"],
  "core.stephen_summaries": ["person_id"],
  "core.stephen_summary_readers": ["person_id"],
  "core.team_members": ["user_id"],
  "core.teams": ["member_count"],
  "core.tool_class_settings": ["changed_by"],
  "core.trigger_resource_versions": ["principal_binding"],
  "core.trigger_resources": ["email_address", "owner_id", "principal_binding"],
  "core.uploads": ["actor", "uploaded_by"],
  "core.users": ["email", "email_verified"],
  "core.workflow_binding_approvals": ["approved_by", "revoked_by"],
  "core.workflow_candidate_runs": ["principal_id"],
  "core.workflow_catalog_contracts": ["published_by"],
  "core.workflow_decision_confirmations": ["user_id"],
  "core.workflow_decision_recipients": ["deciders"],
  "core.workflow_decisions": ["decided_by", "deciders"],
  "core.workflow_emitted_events": ["subject"],
  "core.workflow_item_tests": ["principal_id"],
  "core.workflow_model_waits": ["owner"],
  "core.model_usage": ["person_id"],
  "core.workflow_resource_drafts": ["edited_by"],
  "core.workflow_resource_lifecycles": [
    "go_live_requested_by",
    "live_approved_by",
    "paused_by",
  ],
  "core.workflow_resource_members": ["added_by", "member_id", "member_type"],
  "core.workflow_resource_params": ["set_by"],
  "core.workflow_resource_processes": ["set_by"],
  "core.workflow_resource_run_controls": ["principal_id"],
  "core.workflow_resource_runs": ["principal_id"],
  "core.workflow_resource_versions": ["author_id"],
  "core.workflow_resources": ["name_released_by", "owner_id"],
  "core.workflow_run_controls": ["requested_by"],
  "core.workflow_run_files": ["opened_by"],
  "core.workflow_runs": ["started_by"],
  "core.workflow_start_receipts": ["principal_id"],
  "dataStore.sdk_abandoned_targets": ["abandoned_by"],
  "dataStore.sdk_cascade_jobs": ["actor", "principal"],
  "dataStore.sdk_commit_writers": ["principal"],
  "dataStore.sdk_file_delete_keys": ["owner_id"],
  "dataStore.sdk_files": ["owner_id"],
  "dataStore.sdk_mutation_receipts": ["principal"],
  "dataStore.sdk_import_rows": ["principal"],
  "dataStore.sdk_preferences": ["person_id"],
  "dataStore.sdk_record_changes": ["actor", "principal"],
  "dataStore.sdk_records": ["owner_id"],
  "dataStore.sdk_schema_backfills": ["cursor_owner"],
  "dataStore.sdk_store": ["deleted_by"],
  "onboarding.approvals": ["person"],
  "onboarding.asked_about": ["person"],
  "onboarding.brain_interviews": ["person", "user_id"],
  "onboarding.brain_sent": ["person"],
  "onboarding.counted": ["person"],
  "onboarding.interview_settings": ["person"],
  "onboarding.interview_states": ["person"],
  "onboarding.interviews": ["person"],
  "onboarding.link_codes": ["person"],
  "onboarding.links": ["person", "sent_to_email", "user_id"],
  "onboarding.participations": ["person"],
  "onboarding.people": ["email"],
  "onboarding.readbacks": ["person"],
  "onboarding.referrals": ["person"],
  "workspace.chats": ["person_id"],
  "workspace.custom_widgets": ["person_id"],
  "workspace.dashboard_widgets": ["person_id"],
  "workspace.dashboards": ["person_id"],
  "workspace.held_app_calls": ["person_id"],
};
