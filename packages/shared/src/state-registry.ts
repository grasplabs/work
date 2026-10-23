/**
 * Every place a client deployment keeps state (spec 46.1): each D1
 * database and its tables, each Durable Object namespace with its tables,
 * keys and facets and how its objects are found, and each R2 bucket by
 * key prefix. Each says which module owns it, whether it is authoritative
 * or derived, and whether a client's export carries it.
 *
 * Pure data, so core (the export) and the console (the move) read the same
 * list. `vp run check:state-registry` (scripts/check-state-registry.ts)
 * fails when this list and the repo differ either way: a database, table,
 * Durable Object class or binding, or bucket without an entry, or an entry
 * for one that is gone. R2 key prefixes and Durable Object KV keys are
 * listed by hand; nothing checks them yet.
 *
 * Paths are from the repo root. A table, key or prefix entry's `owner` is
 * the module that writes it; a runtime table's is the file that makes it,
 * which the check holds it to.
 */

/**
 * Whether a piece of state is the only record of what it holds.
 *
 * - `authoritative`: losing it loses something (a record, a receipt, a
 *   deadline, an obligation still owed).
 * - `derived`: rebuildable from authoritative state, the release or the
 *   provider it was read from, as search projections are (spec 40.7).
 */
export type StateKind = "authoritative" | "derived";

/**
 * What a client's export does with a piece of state.
 *
 * - `exported`: moves with the client (spec 46.1).
 * - `secret`: key material or a credential. Never in the state export:
 *   a client-specific one moves only in the separate encrypted envelope,
 *   where transfer is permitted, or people authenticate again (46.2).
 * - `cache`: derived state the destination rebuilds.
 * - `transient`: work in flight (a lease, an admission queue, a flow a
 *   person hasn't finished) that the cutover drains or lets lapse before
 *   the snapshot (46.2 step 3), so a destination starts with none.
 */
export type ExportClass = "exported" | "secret" | "cache" | "transient";

/** One piece of state: a table, a KV key or prefix, a facet, a key prefix. */
export interface StateEntry {
  /** The module that writes it, from the repo root. */
  owner: string;
  kind: StateKind;
  export: ExportClass;
  /** What a reader of the export needs to know beyond the above. */
  note?: string;
}

/** A table of a registered database or namespace: `<role>/<table>`. */
export type TableRef = `${string}/${string}`;

/**
 * How a namespace's logical objects are found, which a logical export
 * enumerates them by: Cloudflare offers no listing of a namespace's
 * objects, so each one must be named from state core keeps.
 */
export type ObjectRefs =
  | {
      kind: "singleton";
      /** The one object's name (`getByName`). */
      name: string;
    }
  | {
      kind: "named";
      /** How an object's name is made. */
      name: string;
      /**
       * The tables whose rows name the objects. Empty when nothing lists
       * them: such a namespace can't be enumerated yet (spec 46.1's
       * durable object registry is still to come).
       */
      inventories: readonly TableRef[];
      note?: string;
    };

/** A Worker deployed per client, by its config. */
export interface ClientWorker {
  config: string;
}

/** A D1 database and its tables. */
export interface D1State {
  /** The logical role a client's resource inventory maps (spec 39.2). */
  role: string;
  worker: string;
  binding: string;
  /** The database name in the repo's config; a client's physical one differs. */
  database: string;
  /** The schema folder: its `schema.ts` and `migrations/`. */
  schema: string;
  tables: Readonly<Record<string, StateEntry>>;
}

/** A Durable Object namespace: its class, its objects and their storage. */
export interface DurableObjectState {
  role: string;
  worker: string;
  binding: string;
  className: string;
  /** The module that defines the class. */
  owner: string;
  objects: ObjectRefs;
  /** The schema folder of its Drizzle-managed SQLite, if it has one. */
  schema?: string;
  /** Each object's tables of `schema`. */
  tables?: Readonly<Record<string, StateEntry>>;
  /**
   * Each object's tables made at runtime outside a schema: `owner` is the
   * file whose `CREATE TABLE IF NOT EXISTS` makes it.
   */
  runtimeTables?: Readonly<Record<string, StateEntry>>;
  /** Each object's KV storage, by key or by key prefix (ending `:`). */
  kv?: Readonly<Record<string, StateEntry>>;
  /**
   * Nested facets (Durable Object facets) of each object, by facet name:
   * storage of their own, which the object's own storage doesn't hold.
   */
  facets?: Readonly<Record<string, StateEntry>>;
}

/** An R2 bucket, by the key prefixes its objects are stored under. */
export interface R2State {
  role: string;
  worker: string;
  binding: string;
  /** The bucket name in the repo's config; a client's physical one differs. */
  bucket: string;
  prefixes: Readonly<Record<string, StateEntry>>;
}

/**
 * A class that stores another resource's state physically, on a profile
 * without that resource: on plain workerd, D1 databases and R2 buckets are
 * Durable Objects. Its state is the carried resource's, so it is exported
 * as that resource, never as an object of its own.
 */
export interface Carrier {
  className: string;
  owner: string;
  /** The roles it carries. */
  carries: readonly string[];
  /** The tables it makes to carry them. */
  runtimeTables: Readonly<Record<string, StateEntry>>;
}

export interface ClientStateRegistry {
  /** The Workers deployed per client, by name. */
  workers: Readonly<Record<string, ClientWorker>>;
  /** Worker configs in the repo that hold no client state, and why. */
  notClientState: Readonly<Record<string, string>>;
  d1: readonly D1State[];
  durableObjects: readonly DurableObjectState[];
  r2: readonly R2State[];
  carriers: readonly Carrier[];
  /**
   * Tables made by shared machinery inside every object or database that
   * uses it, by name.
   */
  bookkeeping: Readonly<Record<string, StateEntry>>;
}

const core = "apps/core/src/";
const connect = "apps/connect/src/";
const workerflow = "packages/workerflow/src/";

const exported = (owner: string, note?: string): StateEntry => ({
  owner,
  kind: "authoritative",
  export: "exported",
  ...(note === undefined ? {} : { note }),
});

const secret = (owner: string, note?: string): StateEntry => ({
  owner,
  kind: "authoritative",
  export: "secret",
  ...(note === undefined ? {} : { note }),
});

const transient = (owner: string, note?: string): StateEntry => ({
  owner,
  kind: "authoritative",
  export: "transient",
  ...(note === undefined ? {} : { note }),
});

const cache = (owner: string, note?: string): StateEntry => ({
  owner,
  kind: "derived",
  export: "cache",
  ...(note === undefined ? {} : { note }),
});

/** Derived, yet carried: a destination's release may not rebuild it. */
const pinned = (owner: string, note: string): StateEntry => ({
  owner,
  kind: "derived",
  export: "exported",
  note,
});

const brainPending =
  "Brain content: its export format waits on GRA-291 (retained Brain content representations).";

const auth = `${core}auth/auth.ts`;

const coreDb: D1State = {
  role: "core-db",
  worker: "core",
  binding: "DB",
  database: "grasp-os-core",
  schema: `${core}db/core`,
  tables: {
    users: exported(auth),
    sessions: secret(
      auth,
      "Bearer tokens of signed-in browsers: people sign in again at the destination (46.2)."
    ),
    accounts: exported(auth),
    verifications: transient(auth, "Sign-ins in progress."),
    jwks: secret(
      `${core}auth/app-tokens.ts`,
      "App token signing keys, private keys encrypted with BETTER_AUTH_SECRET."
    ),
    organizations: exported(auth),
    members: exported(auth),
    member_removals: exported(`${core}organization.ts`),
    invitations: exported(auth),
    teams: exported(auth),
    team_members: exported(auth),
    sso_providers: exported(auth),
    audit_outbox: exported(`${core}audit-outbox.ts`),
    audit_outbox_rejected: exported(`${core}audit-outbox.ts`),
    permissions: exported(`${core}permissions.ts`),
    apps: exported(`${core}apps.ts`),
    access_revocations: exported(`${core}access-revocations.ts`),
    app_members: exported(`${core}app-access.ts`),
    screen_artifacts: exported(`${core}screen-trust.ts`),
    screen_builds: cache(`${core}screen-builds.ts`),
    build_receipts: cache(
      `${core}build-cache.ts`,
      "What vouches for a kept build's bytes, and the lease of the build making it: without it every build compiles again."
    ),
    screen_policies: exported(`${core}screen-trust.ts`),
    blueprints: exported(`${core}app-blueprints.ts`),
    app_versions: exported(`${core}apps.ts`),
    app_candidates: exported(`${core}app-candidates.ts`),
    app_candidate_reports: exported(`${core}app-candidates.ts`),
    sdk_release_manifests: exported(`${core}app-releases.ts`),
    sdk_release_artifacts: exported(`${core}app-releases.ts`),
    sdk_artifact_deletions: transient(`${core}release-retention.ts`),
    sdk_artifact_candidates: exported(`${core}release-retention.ts`),
    sdk_release_tombstones: exported(`${core}release-retention.ts`),
    sdk_release_pins: exported(`${core}release-retention.ts`),
    sdk_resource_bindings: exported(`${core}app-releases.ts`),
    business_store_versions: exported(`${core}data-stores.ts`),
    sdk_store_owners: exported(`${core}app-releases.ts`),
    app_default_stores: exported(`${core}app-activation.ts`),
    app_test_fixtures: transient(`${core}app-tests.ts`),
    app_test_runs: transient(`${core}workflows/fixture-runs.ts`),
    app_test_decisions: transient(`${core}workflows/fixture-decisions.ts`),
    screen_submissions: exported(`${core}screen-submissions.ts`),
    action_invocations: exported(`${core}action-invocation.ts`),
    preview_fixture_stores: transient(`${core}sealed-previews.ts`),
    resource_templates: exported(`${core}resource-bindings.ts`),
    app_resource_bindings: exported(`${core}resource-bindings.ts`),
    workflow_runs: exported(`${core}workflows/runs.ts`),
    run_lineages: exported(`${core}workflows/quotas.ts`),
    run_lineage_attempts: exported(`${core}workflows/quotas.ts`),
    workflow_admission_queue: transient(`${core}workflows/admission.ts`),
    build_leases: transient(`${core}build-admission.ts`),
    build_commit_fences: transient(`${core}build-admission.ts`),
    build_admission_queue: transient(`${core}build-admission.ts`),
    workflow_model_waits: cache(`${core}workflows/model-waits.ts`),
    run_mail_stamps: exported(`${core}workflows/mail-stamps.ts`),
    run_mail_calls: exported(`${core}workflows/mail-stamps.ts`),
    run_mail_stamp_claims: exported(`${core}workflows/mail-stamps.ts`),
    run_mail_stamp_refusals: exported(`${core}workflows/connector-events.ts`),
    run_lineage_accounts: exported(`${core}workflows/quotas.ts`),
    run_lineage_children: exported(`${core}workflows/quotas.ts`),
    mail_domains: exported(`${core}workflows/inbound-email.ts`),
    quota_policies: exported(`${core}workflows/quotas.ts`),
    workflow_run_controls: exported(`${core}workflows/controls.ts`),
    workflow_run_wakes: exported(`${core}workflows/wakes.ts`),
    workflow_triggers: exported(
      `${core}workflows/trigger-registry.ts`,
      "Schedules: their next ticks are deadlines a move keeps (46.2 step 9)."
    ),
    workflow_decisions: exported(`${core}decisions/decisions.ts`),
    workflow_decision_confirmations: transient(
      `${core}decisions/confirmations.ts`,
      "One-use confirmations, minutes long."
    ),
    dependency_requests: exported(`${core}dependencies/requests.ts`),
    onboarding_gate: exported(`${core}onboarding/gate.ts`),
    dependency_policy: exported(`${core}dependencies/approvers.ts`),
    dependency_approvers: exported(`${core}dependencies/approvers.ts`),
    dependency_locks: exported(`${core}packages/resolve.ts`),
    package_cleanups: transient(`${core}packages/cleanup.ts`),
    dependency_build_leases: transient(`${core}packages/build.ts`),
    dependency_admission_refusals: exported(`${core}dependencies/requests.ts`),
    workflow_param_values: exported(`${core}workflows/params.ts`),
    workflow_owners: exported(`${core}workflows/owners.ts`),
    hidden_connectors: exported(`${core}connections.ts`),
    app_requests: exported(`${core}app-requests.ts`),
    improvement_signal_computations: cache(`${core}signals.ts`),
    improvement_signals: cache(`${core}signals.ts`),
    app_statistics: exported(`${core}statistics.ts`),
    app_statistic_steps: exported(`${core}statistics.ts`),
    platform_versions: exported(`${core}platform-updates.ts`),
    notifications: exported(`${core}notifications.ts`),
    guest_chats: exported(`${core}guests.ts`),
    guest_messages: exported(`${core}guests.ts`),
    migration_samples: exported(`${core}migration-samples.ts`),
    migration_sample_leases: transient(`${core}migration-samples.ts`),
    business_stores: exported(`${core}data-stores.ts`),
    business_store_members: exported(`${core}data-stores.ts`),
    workflow_resources: exported(`${core}workflow-resources.ts`),
    workflow_resource_versions: exported(`${core}workflow-resources.ts`),
    workflow_resource_members: exported(`${core}workflow-resources.ts`),
    trigger_resources: exported(`${core}trigger-resources.ts`),
    trigger_resource_versions: exported(`${core}trigger-resources.ts`),
    workflow_start_receipts: exported(`${core}workflow-starts.ts`),
    workflow_resource_runs: exported(`${core}workflows/resource-runs.ts`),
    workflow_emitted_events: exported(
      `${core}workflows/emitted-events.ts`,
      "The events JSON workflows' emit tasks wrote: an outbox, its undelivered rows still owed."
    ),
    workflow_run_files: exported(`${core}workflows/run-files.ts`),
    workflow_run_file_chunks: exported(`${core}workflows/run-files.ts`),
    workflow_resource_run_terminations: exported(
      `${core}workflows/resource-runs.ts`
    ),
    workflow_resource_run_controls: exported(`${core}screen-workflows.ts`),
    workflow_catalog_contracts: exported(`${core}workflow-catalog.ts`),
    workflow_binding_approvals: exported(`${core}workflow-bindings.ts`),
    workflow_resource_params: exported(`${core}workflow-params.ts`),
    workflow_resource_drafts: exported(`${core}workflow-drafts.ts`),
    workflow_resource_draft_modules: exported(`${core}workflow-drafts.ts`),
    workflow_resource_draft_inspections: cache(`${core}workflow-drafts.ts`),
    app_workflow_bindings: exported(`${core}app-workflow-bindings.ts`),
    workflow_candidate_runs: exported(`${core}workflows/candidate-runs.ts`),
    landscape_syncs: transient(`${core}landscape.ts`),
    landscape_apps: cache(
      `${core}landscape.ts`,
      "As last read from the tenant; the next sync reads it again."
    ),
    landscape_app_people: cache(`${core}landscape.ts`),
    landscape_staged_apps: transient(`${core}landscape.ts`),
    landscape_staged_people: transient(`${core}landscape.ts`),
    brain_records: exported(`${core}brain-records.ts`, brainPending),
    brain_gap_states: exported(`${core}brain-gaps.ts`),
  },
};

const knowledgeDb: D1State = {
  role: "knowledge-db",
  worker: "core",
  binding: "KNOWLEDGE",
  database: "grasp-os-knowledge",
  schema: `${core}db/knowledge`,
  tables: {
    collections: exported(`${core}knowledge/collections.ts`, brainPending),
    collection_teams: exported(`${core}knowledge/collections.ts`),
    documents: exported(`${core}knowledge/documents.ts`, brainPending),
    versions: exported(`${core}knowledge/documents.ts`, brainPending),
    sections: cache(
      `${core}knowledge/documents.ts`,
      "The current version's text, split by heading."
    ),
    links: cache(`${core}knowledge/documents.ts`),
    search_rows: cache(`${core}knowledge/search.ts`, "Search projection."),
    search_words: cache(`${core}knowledge/search.ts`, "Search projection."),
    search_trigrams: cache(`${core}knowledge/search.ts`, "Search projection."),
    search_rebuilds: cache(`${core}knowledge/search-erasure.ts`),
    app_entries: cache(`${core}knowledge/apps-collection.ts`),
    uploads: exported(`${core}knowledge/uploads.ts`, brainPending),
    upload_cleanups: exported(
      `${core}knowledge/uploads.ts`,
      "Deletions still owed, purges' included."
    ),
    knowledge_signal_computations: cache(`${core}knowledge/signals.ts`),
    knowledge_signals: cache(`${core}knowledge/signals.ts`),
    knowledge_signal_dismissals: exported(`${core}knowledge/signals.ts`),
    brain_payloads: exported(`${core}knowledge/payloads.ts`, brainPending),
    brain_payload_releases: transient(
      `${core}knowledge/payloads.ts`,
      "Empty between batches."
    ),
    brain_memories: exported(`${core}knowledge/memories.ts`, brainPending),
    brain_receipts: transient(
      `${core}knowledge/memories.ts`,
      "Command receipts for retries, swept a day after the command."
    ),
    audit_outbox: exported(
      `${core}audit-outbox.ts`,
      "Made by the database's migrations, outside its Drizzle schema."
    ),
    audit_outbox_rejected: exported(
      `${core}audit-outbox.ts`,
      "Made by the database's migrations, outside its Drizzle schema."
    ),
  },
};

const connectDb: D1State = {
  role: "connect-db",
  worker: "connect",
  binding: "DB",
  database: "grasp-os-connect",
  schema: `${connect}db`,
  tables: {
    connections: exported(`${connect}connections.ts`),
    idempotent_calls: exported(`${connect}idempotency.ts`),
    pending_actions: exported(`${connect}pending.ts`),
    oauth_flows: transient(`${connect}oauth.ts`),
    composio_flows: transient(`${connect}composio-connections.ts`),
    composio_cleanups: exported(
      `${connect}composio-connections.ts`,
      "Deletions at Composio still owed."
    ),
    connection_tokens: secret(
      `${connect}vault.ts`,
      "OAuth tokens sealed with TOKEN_ENCRYPTION_KEY: only the encrypted envelope may carry them."
    ),
    audit_outbox: exported(`${connect}audit.ts`),
    audit_outbox_rejected: exported(`${connect}audit.ts`),
    event_sources: exported(`${connect}events.ts`),
    connector_events: exported(`${connect}events.ts`),
  },
};

const workspaces: DurableObjectState = {
  role: "workspaces",
  worker: "core",
  binding: "WORKSPACES",
  className: "Workspace",
  owner: `${core}workspace.ts`,
  objects: {
    kind: "named",
    name: "`person:<user ID>`, a person's own (chats-rpc.ts, `personalWorkspaceId`).",
    inventories: ["core-db/users"],
    note: "Only personal workspaces have an inventory: nothing lists another workspace's object.",
  },
  schema: `${core}db/workspace`,
  tables: {
    chats: exported(`${core}workspace.ts`),
    chat_projects: exported(`${core}workspace.ts`),
    chat_project_documents: exported(`${core}workspace.ts`),
    chat_messages: exported(`${core}workspace.ts`),
    chat_sources: exported(`${core}workspace.ts`),
    chat_run_sources: exported(`${core}workspace.ts`),
    chat_documents: exported(`${core}workspace.ts`),
    chat_drafts: exported(`${core}workspace.ts`),
    chat_draft_files: exported(`${core}workspace.ts`),
    audit_outbox: exported(`${core}workspace.ts`),
    chat_attachments: exported(`${core}workspace.ts`),
    chat_code_runs: exported(`${core}workspace.ts`),
    chat_build_jobs: exported(`${core}build-jobs.ts`),
    dashboards: exported(`${core}workspace.ts`),
    dashboard_widgets: exported(`${core}workspace.ts`),
    email_preferences: exported(`${core}workspace.ts`),
    preview_releases: cache(`${core}sealed-previews.ts`),
    preview_release_artifacts: cache(`${core}sealed-previews.ts`),
    preview_stores: transient(`${core}sealed-previews.ts`),
  },
  kv: {
    "turn:": transient(
      `${core}workspace.ts`,
      "A chat's turn under way, by chat."
    ),
  },
};

const apps: DurableObjectState = {
  role: "apps",
  worker: "core",
  binding: "APPS",
  className: "App",
  owner: `${core}app.ts`,
  objects: {
    kind: "named",
    name: "The App's ID (durable-objects.ts, `appHost`).",
    inventories: ["core-db/apps"],
  },
  kv: {
    generation: exported(`${core}app.ts`),
    version: exported(`${core}app.ts`),
    restricted: exported(`${core}app.ts`, "The App's restricted mode."),
    "action-holds:": transient(`${core}app.ts`),
    "stream-holds:": transient(`${core}app.ts`),
    "error-log:": exported(`${core}app-error-log.ts`),
    "error-log-count": exported(`${core}app-error-log.ts`),
    "error-log-suppressed": exported(`${core}app-error-log.ts`),
  },
  facets: {
    server: exported(
      `${core}app.ts`,
      "The App's server code's own SQLite, in a schema the App defines."
    ),
  },
};

const auditLog: DurableObjectState = {
  role: "audit-log",
  worker: "core",
  binding: "AUDIT_LOG",
  className: "AuditLog",
  owner: `${core}audit-log.ts`,
  objects: { kind: "singleton", name: "audit-log" },
  schema: `${core}db/audit-log`,
  tables: {
    events: exported(`${core}audit-log.ts`),
    archives: exported(`${core}audit-log.ts`),
  },
  kv: {
    "verify.pass": transient(`${core}audit-log.ts`),
    "verify.last": exported(`${core}audit-log.ts`),
  },
};

const builtins: DurableObjectState = {
  role: "builtins",
  worker: "core",
  binding: "BUILTINS",
  className: "Builtins",
  owner: `${core}builtins.ts`,
  objects: { kind: "singleton", name: "builtins" },
  kv: {
    installed: cache(
      `${core}builtins.ts`,
      "The fingerprint of what this release installed; the destination installs its own."
    ),
  },
};

const onboarding: DurableObjectState = {
  role: "onboarding",
  worker: "core",
  binding: "ONBOARDING",
  className: "Onboarding",
  owner: `${core}onboarding/store.ts`,
  objects: { kind: "singleton", name: "onboarding" },
  schema: `${core}db/onboarding`,
  tables: {
    onboarding: exported(`${core}onboarding/store.ts`),
    teams: exported(`${core}onboarding/store.ts`),
    people: exported(`${core}onboarding/store.ts`),
    links: exported(`${core}onboarding/store.ts`),
    link_codes: exported(
      `${core}onboarding/links.ts`,
      "A link's secret is made from its code with core's key, which moves only in the envelope."
    ),
    interviews: exported(`${core}onboarding/store.ts`),
    interview_states: exported(`${core}onboarding/store.ts`),
    counted: exported(`${core}onboarding/store.ts`),
    team_counts: exported(`${core}onboarding/store.ts`),
    events: exported(`${core}onboarding/store.ts`),
    notes: exported(`${core}onboarding/store.ts`),
    kickoff: exported(`${core}onboarding/kickoff.ts`),
    documents: exported(`${core}onboarding/documents.ts`),
    usage: exported(`${core}onboarding/store.ts`),
    interview_texts: exported(`${core}onboarding/store.ts`),
    works: exported(`${core}onboarding/store.ts`),
    asked_about: exported(`${core}onboarding/store.ts`),
    drawn_works: exported(`${core}onboarding/store.ts`),
    brain_teams: exported(`${core}onboarding/store.ts`),
    brain_sent: exported(
      `${core}onboarding/store.ts`,
      "Who each record the onboarding gave the brain rests on: what deleting an interview takes out of it."
    ),
    draw_failures: transient(
      `${core}onboarding/store.ts`,
      "Drawings that failed, waiting to be tried again: a destination draws anew."
    ),
    interview_settings: exported(`${core}onboarding/store.ts`),
    answer_waits: exported(`${core}onboarding/store.ts`),
    voice_use: transient(
      `${core}onboarding/store.ts`,
      "Today's seconds of voice, a limit's count: each count deletes the days before it."
    ),
    audit_outbox: exported(`${core}onboarding/store.ts`),
    mail_outbox: exported(
      `${core}mail-outbox.ts`,
      "Holds no link secret: a link is filled in only as its mail is sent."
    ),
  },
};

const modelLedger: DurableObjectState = {
  role: "model-ledger",
  worker: "core",
  binding: "MODEL_LEDGER",
  className: "ModelLedger",
  owner: `${core}model-ledger.ts`,
  objects: { kind: "singleton", name: "deployment" },
  schema: `${core}db/model-ledger`,
  tables: {
    requests: exported(`${core}model-ledger.ts`),
    queue: transient(`${core}model-admission.ts`),
    policy: exported(`${core}model-ledger.ts`),
    request_scopes: exported(`${core}model-ledger.ts`),
    spend: exported(`${core}model-ledger.ts`),
    alerts: exported(`${core}model-ledger.ts`),
    audit_outbox: exported(`${core}model-ledger.ts`),
  },
};

const dataStores: DurableObjectState = {
  role: "data-stores",
  worker: "core",
  binding: "DATA_STORES",
  className: "DataStore",
  owner: `${core}data-store.ts`,
  objects: {
    kind: "named",
    name: "The store's ID, minted by the host (data-stores.ts).",
    inventories: [
      "core-db/business_stores",
      "core-db/app_default_stores",
      "core-db/app_test_fixtures",
      "core-db/preview_fixture_stores",
      "workspaces/preview_stores",
    ],
    note: "Fixture stores (tests, previews) are transient; a discarded one keeps only `grasp_fixture_discarded`.",
  },
  schema: `${core}db/data-store`,
  tables: {
    sdk_store: exported(`${core}store-host.ts`),
    sdk_tables: exported(`${core}store-host.ts`),
    sdk_records: exported(`${core}store-host.ts`),
    sdk_record_refs: exported(`${core}store-references.ts`),
    sdk_schemas: exported(`${core}store-host.ts`),
    sdk_schema_activations: exported(`${core}store-host.ts`),
    sdk_reserved_fields: exported(`${core}store-host.ts`),
    sdk_abandoned_targets: exported(`${core}store-host.ts`),
    sdk_schema_backfills: exported(`${core}store-host.ts`),
    sdk_migration_work: exported(`${core}store-migrations.ts`),
    sdk_mutation_receipts: exported(`${core}data-store.ts`),
    sdk_change_outbox: exported(`${core}data-store.ts`),
    sdk_commit_writers: exported(`${core}store-operations.ts`),
    sdk_files: exported(`${core}file-host.ts`),
    sdk_file_delete_keys: exported(`${core}file-host.ts`),
    sdk_file_chunks: exported(`${core}file-host.ts`),
    sdk_file_writes: transient(`${core}file-host.ts`),
    sdk_file_events: exported(`${core}file-host.ts`),
    sdk_file_refs: exported(`${core}store-host.ts`),
    sdk_preferences: exported(`${core}app-preferences.ts`),
    sdk_cascade_jobs: exported(`${core}store-host.ts`),
    sdk_cascade_members: exported(`${core}store-host.ts`),
  },
  kv: {
    grasp_fixture_discarded: transient(`${core}data-store.ts`),
  },
};

const workflowRuns: DurableObjectState = {
  role: "workflow-runs",
  worker: "core",
  binding: "WORKFLOW_RUNS",
  className: "WorkflowRuns",
  owner: `${core}workflows/run-object.ts`,
  objects: {
    kind: "named",
    name: '`["workerflow-run", <definition>, <run ID>]` as JSON (workerflow\'s `runObjectName`).',
    inventories: [
      "core-db/workflow_runs",
      "core-db/workflow_resource_runs",
      "core-db/workflow_candidate_runs",
      "core-db/app_test_runs",
      "workspaces/chat_build_jobs",
    ],
    note: "Runs of core's own workflows (extraction, backfills) are found only through the rows that started them. Runs an App's tests start are transient, removed with their test.",
  },
  runtimeTables: {
    run: exported(`${workerflow}journal.ts`, "The workflow journal."),
    activations: exported(`${workerflow}journal.ts`),
    steps: exported(`${workerflow}journal.ts`),
    attempts: exported(`${workerflow}journal.ts`),
    events: exported(`${workerflow}journal.ts`),
    tombstones: exported(`${workerflow}journal.ts`),
    history: exported(`${workerflow}history.ts`),
    notifications: exported(`${workerflow}notifications.ts`),
    stream_chunks: exported(`${workerflow}streams.ts`),
    grasp_busy_refusals: exported(`${core}workflows/run-object.ts`),
    grasp_tried_once: exported(`${core}workflows/run-object.ts`),
    grasp_action_model_calls: exported(`${core}workflows/run-object.ts`),
    grasp_run_cancelled: exported(`${core}workflows/run-object.ts`),
    grasp_run_apps: exported(`${core}workflows/run-object.ts`),
    grasp_run_shares: exported(`${core}workflows/run-object.ts`),
  },
};

const actionInvocations: DurableObjectState = {
  role: "action-invocations",
  worker: "core",
  binding: "ACTION_INVOCATIONS",
  className: "ActionInvocation",
  owner: `${core}action-invocation.ts`,
  objects: {
    kind: "named",
    name: "The SHA-256 of its person, App, contract and key (`invocationName`).",
    inventories: ["core-db/action_invocations"],
    note: "Listed before it records a run and unlisted once it empties itself; one from before the inventory has no row and goes within about a day.",
  },
  kv: {
    invocation: exported(`${core}action-invocation.ts`),
  },
};

/** Each Worker's clock: one object running its maintenance tasks (spec 43.5). */
const clockTasks = transient(
  `${workerflow}clock.ts`,
  "Each task's last slot and lease: the destination's clock starts its own, and its tasks are maintenance that runs again safely; schedules' own deadlines are in workflow_triggers."
);

const coreClock: DurableObjectState = {
  role: "core-clock",
  worker: "core",
  binding: "CLOCK",
  className: "Clock",
  owner: `${core}clock.ts`,
  objects: { kind: "singleton", name: "clock" },
  runtimeTables: { clock_tasks: clockTasks },
};

const connectClock: DurableObjectState = {
  role: "connect-clock",
  worker: "connect",
  binding: "CLOCK",
  className: "Clock",
  owner: `${connect}clock.ts`,
  objects: { kind: "singleton", name: "clock" },
  runtimeTables: { clock_tasks: clockTasks },
};

const files: R2State = {
  role: "files",
  worker: "core",
  binding: "FILES",
  bucket: "grasp-os-files",
  prefixes: {
    "apps/": exported(
      `${core}apps.ts`,
      "Versions' file trees by hash (`apps/<app>/trees/`); `apps/<app>/tests/` holds test builds, a cache."
    ),
    "blueprints/": pinned(
      `${core}apps.ts`,
      "Built-in blueprints' file trees: the destination's release ships its own, but versions made from older ones name these."
    ),
    "release-artifacts/": exported(
      `${core}app-releases.ts`,
      "Pinned definition artifacts of sealed releases, by SHA-256."
    ),
    "run-files/": exported(`${core}workflows/run-files.ts`),
    "app-files/": exported(`${core}file-host.ts`, "Stores' files, by store."),
    "inbound-email/": exported(`${core}workflows/kept-email.ts`),
    "knowledge/": exported(`${core}knowledge/uploads.ts`, brainPending),
    "npm-tarballs/": cache(`${core}packages/tarballs.ts`),
    "package-builds/": cache(`${core}packages/build.ts`),
    "screen-builds/": cache(`${core}screens.ts`),
    "server-builds/": cache(`${core}screens.ts`),
    "workflow-builds/": cache(`${core}screens.ts`),
    "app-builds/": cache(`${core}screens.ts`),
    "app-check-builds/": cache(`${core}screens.ts`),
    "app-tests-builds/": cache(`${core}screens.ts`),
    "open-workflow-builds/": cache(`${core}screens.ts`),
    "compute-builds/": cache(`${core}screens.ts`),
    "build-quarantine/": cache(
      `${core}build-cache.ts`,
      "Builds whose bytes failed their receipt's hash, kept a day to look into."
    ),
    "builds-sweep.json": cache(`${core}screens.ts`),
    "screen-frames/": cache(`${core}screen-frame.ts`),
    "screen-modules/": cache(`${core}screen-frame.ts`),
    "screen-frames-sweep.json": cache(`${core}screen-frame.ts`),
    "workflow-metadata/": cache(`${core}workflows/code.ts`),
    "inspections/": cache(`${core}app-inspection.ts`),
  },
};

const brainObjects: R2State = {
  role: "brain-objects",
  worker: "core",
  binding: "BRAIN_OBJECTS",
  bucket: "grasp-os-brain-objects",
  prefixes: {
    "payloads/": exported(
      `${core}knowledge/payloads.ts`,
      `Knowledge version texts by SHA-256, each named by its row in brain_payloads. ${brainPending}`
    ),
  },
};

const auditArchive: R2State = {
  role: "audit-archive",
  worker: "core",
  binding: "AUDIT_ARCHIVE",
  bucket: "grasp-os-audit-archive",
  prefixes: {
    "audit-log/": exported(
      `${core}audit-log.ts`,
      "Keyed by the audit log object's provider ID, which isn't a destination identity (46.1)."
    ),
  },
};

/** Every place a client deployment keeps state. */
export const clientStateRegistry: ClientStateRegistry = {
  workers: {
    core: { config: "apps/core/wrangler.jsonc" },
    connect: { config: "apps/connect/wrangler.jsonc" },
  },
  notClientState: {
    "apps/console/wrangler.jsonc":
      "The staff console runs once, in grasp-os-ops: its state is Grasp's, about clients.",
    "apps/router/wrangler.jsonc":
      "The router runs once, in grasp-os-ops, and holds only hostnames the console writes.",
  },
  d1: [coreDb, knowledgeDb, connectDb],
  durableObjects: [
    workspaces,
    apps,
    auditLog,
    builtins,
    onboarding,
    modelLedger,
    dataStores,
    workflowRuns,
    actionInvocations,
    coreClock,
    connectClock,
  ],
  r2: [files, brainObjects, auditArchive],
  carriers: [
    {
      className: "D1Store",
      owner: `${core}on-prem/d1.ts`,
      carries: ["core-db", "knowledge-db"],
      runtimeTables: {
        d1_migrations: exported(`${core}on-prem/d1.ts`),
      },
    },
    {
      className: "R2Store",
      owner: `${core}on-prem/r2.ts`,
      carries: ["files", "audit-archive"],
      runtimeTables: {
        objects: exported(`${core}on-prem/r2.ts`),
        chunks: exported(`${core}on-prem/r2.ts`),
      },
    },
  ],
  bookkeeping: {
    _migrations: exported(
      `${core}db/migrate.ts`,
      "The schema migrations each Durable Object with a schema applied: its schema version."
    ),
  },
};
