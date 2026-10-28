/**
 * Admin D1 schema: intent and history only. What runs in a client's
 * account (live Worker versions, secrets) is read from that account; the
 * token that reaches client accounts lives in Secrets Store, never here
 * (threat model R17).
 */
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

/** A release CI built and published, imported once its blobs checked out. */
export const releases = sqliteTable("releases", {
  /** `r<run6>-<sha7>`. */
  id: text().primaryKey(),
  commitSha: text("commit_sha").notNull(),
  /** The release's manifest, as CI wrote it: JSON. */
  manifest: text().notNull(),
  /** The manifest's sha256, hex. */
  manifestSha256: text("manifest_sha256").notNull(),
  builtAt: timestamp("built_at").notNull(),
  importedAt: timestamp("imported_at").notNull(),
  /**
   * Whether its note is a feature, which starts the next major version
   * (src/releases/version.ts): kept on import, so versions are counted
   * without reading every manifest. Null only for one imported before it.
   */
  feature: integer({ mode: "boolean" }),
});

/**
 * A published release that didn't verify, and when the import tries it
 * again (src/releases/import.ts). Gone once it's imported.
 */
export const releaseImportFailures = sqliteTable("release_import_failures", {
  /** The release's id, as its R2 prefix names it. */
  releaseId: text("release_id").primaryKey(),
  /** Failed attempts so far: the wait before the next one doubles each time. */
  attempts: integer().notNull(),
  failedAt: timestamp("failed_at").notNull(),
  nextAttemptAt: timestamp("next_attempt_at").notNull(),
});

/**
 * How far the import has checked a published release whose blobs don't fit
 * in one run's reads (src/releases/import.ts): the first `verifiedBlobs`
 * of them, in its manifest's order, for the manifest with that sha256.
 * Gone once it's imported, or once an attempt fails.
 */
export const releaseImportProgress = sqliteTable("release_import_progress", {
  releaseId: text("release_id").primaryKey(),
  /** The manifest the checked blobs are its: another starts again. */
  manifestSha256: text("manifest_sha256").notNull(),
  verifiedBlobs: integer("verified_blobs").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/** A client: one deployment of Grasp OS in its own Cloudflare account. */
export const clients = sqliteTable(
  "clients",
  {
    /** The client's slug: its subdomain, `<slug>.<domain>`. */
    id: text().primaryKey(),
    name: text().notNull(),
    /** The Cloudflare account the admin adopted for it. */
    accountId: text("account_id").notNull().unique(),
    /**
     * The generation of the client's derived secrets: each is
     * `HMAC(<master key>, "<purpose>:<id>:<generation>")`
     * (src/deploy/secrets.ts), so raising it rotates them with nothing
     * stored.
     */
    generation: integer().notNull().default(1),
    /** When the generation last rose; null before the first rotation. */
    rotatedAt: timestamp("rotated_at"),
    /**
     * When a deploy first made the current generation live; null while the
     * last rotation hasn't reached the client yet. The previous generation's
     * keys are kept for a window from here (src/deploy/secrets.ts).
     */
    rotationLiveAt: timestamp("rotation_live_at"),
    /**
     * The account's workers.dev subdomain, where its core answers
     * (`https://<core>.<subdomain>.workers.dev`); null before the first deploy.
     */
    workersSubdomain: text("workers_subdomain"),
    /** The rollout ring it's in: 0 first. */
    ring: integer().notNull().default(1),
    status: text({ enum: ["provisioning", "active", "offboarded"] })
      .notNull()
      .default("provisioning"),
    /** The staff member who started provisioning it (src/provision/). */
    createdBy: text("created_by"),
    /**
     * How its people sign in, as staff gave it when provisioning: JSON
     * (`clientSignInSchema`, src/deploy/core-config.ts), the client's own
     * Entra tenant and/or Google Workspace, its email domains and first
     * admins. Every deploy makes core's `SIGN_IN` from it; null for a
     * client without one, whose core gets no `SIGN_IN`.
     */
    signIn: text("sign_in"),
    /**
     * Its own Teams bot, as staff set it: JSON (`teamsBotSchema`,
     * src/clients/teams-bot.ts), the bot's app id, its tenant and the day
     * its secret expires, never the secret. Every deploy gives its connect
     * and core the bot's id from it; null for a client without a bot.
     */
    teamsBot: text("teams_bot"),
    /**
     * When staff last changed what a deploy sets on its core: its sign-in
     * or a setting (src/clients/settings.ts). A rollout deploys a client
     * whose latest done deploy started before this, even on the release
     * already (src/rollout/targets.ts); null while nothing changed.
     */
    configChangedAt: timestamp("config_changed_at"),
    /**
     * The client's customer in Grasp's Stripe (`cus_...`), as someone at
     * Grasp linked it by hand (src/billing/link.ts): never matched by name
     * or email, so the admin never shows one company another's invoices.
     * Only the id is kept; what Stripe holds is read each time
     * (src/billing/stripe.ts). Null until it is linked.
     */
    stripeCustomerId: text("stripe_customer_id"),
    /**
     * The client's proposal in Grasp's Rooms: its room's id, as someone at
     * Grasp linked it by hand (src/proposal/link.ts), never matched by
     * name. Only the id is kept; the room and what was signed in it are
     * read each time (src/proposal/rooms.ts). Null until it is linked.
     */
    roomsProjectId: text("rooms_project_id"),
    /**
     * The client's company in Grasp's Attio: its record's id, as someone at
     * Grasp linked it by hand (src/crm/link.ts), never matched by name or
     * domain. Only the id is kept; the company, its people and its deals
     * are read each time (src/crm/attio.ts). Null until it is linked.
     */
    attioCompanyId: text("attio_company_id"),
    /** The release it stays on while pinned, whatever the rollouts. */
    pinnedReleaseId: text("pinned_release_id").references(() => releases.id),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  // What a rollout reaches: the active clients of a ring or two
  // (src/rollout/targets.ts).
  (table) => [index("clients_status_ring_idx").on(table.status, table.ring)]
);

/**
 * The runner that's a client's current one (src/runners.ts): the
 * only one that may change what its account runs. A provisioning run (a
 * Workflow instance per attempt), a rollout while it deploys the client
 * (its Workflow instance), or a rollback of the client (its instance).
 * Each claims it with one conditional write naming the runner it
 * replaces, so however many act at once, one wins: the single runner a
 * client's deploy relies on. No foreign key: a provisioning run is
 * claimed before its account step records the client.
 */
export const clientRuns = sqliteTable("client_runs", {
  /** The client's id, as it will be recorded. */
  clientId: text("client_id").primaryKey(),
  /**
   * The runner's id: a provisioning run's Workflow instance
   * (`<clientId>-<random>`), a rollout's (the rollout's id), a
   * rollback's (`rollback-<random>`), or applying the client's settings
   * (`apply-<random>`, src/clients/apply.ts).
   */
  runId: text("run_id").notNull(),
  /** When it was claimed: a run not created yet counts as starting for a while. */
  claimedAt: timestamp("claimed_at").notNull(),
  /**
   * Which Workflow the runner is an instance of: `provision_placed`
   * provisions a client placed in a hosting destination
   * (src/hosting/workflow.ts).
   */
  kind: text({
    enum: ["provision", "rollout", "rollback", "apply", "provision_placed"],
  })
    .notNull()
    .default("provision"),
});

/**
 * A Worker the admin deployed to a client (core, connect), and what it
 * last deployed there: drift is a live version that differs from this.
 */
export const clientWorkers = sqliteTable(
  "client_workers",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id),
    worker: text({ enum: ["core", "connect"] }).notNull(),
    /** The script's name in the client's account. */
    scriptName: text("script_name").notNull(),
    releaseId: text("release_id").references(() => releases.id),
    versionId: text("version_id"),
    deployedAt: timestamp("deployed_at"),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.worker] })]
);

/**
 * Making a client's account run a release (src/deploy/deploy.ts): how far
 * it got. Every step can run again, so a deploy that failed is resumed by
 * running it again from the start.
 */
export const clientDeploys = sqliteTable(
  "client_deploys",
  {
    id: text().primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id),
    releaseId: text("release_id")
      .notNull()
      .references(() => releases.id),
    /**
     * What it deploys: a release, or on the release the client runs
     * already only new secrets (a secrets rollout, or its own rotated
     * ones), only its settings (applied now, or by a rollout of that
     * release), or both at once. Core records it as what changed.
     */
    kind: text({
      enum: ["release", "secrets", "settings", "settings_and_secrets"],
    })
      .notNull()
      .default("release"),
    /** `superseded`: a newer deploy of the client started, so this one no longer runs. */
    status: text({
      enum: ["running", "done", "failed", "superseded"],
    }).notNull(),
    /** The last step that finished, such as `resources`; null before the first. */
    step: text(),
    /** Why it failed: an error code, never a token or a response body. */
    error: text(),
    /**
     * The versions this deploy uploaded, each with fingerprints of what went
     * into it and of its secrets alone: JSON, `{"byApp": {"connect":
     * {"version": "<id>", "fingerprint": "<hex>", "secrets": "<hex>"}}}`
     * (src/deploy/deploy.ts). A resumed deploy deploys these rather than
     * upload again, unless what goes into one has changed since.
     */
    versions: text(),
    /** The staff member who started it, or `system`. */
    startedBy: text("started_by").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    index("client_deploys_client_idx").on(table.clientId, table.createdAt),
  ]
);

/** Rolling a release (or only new secrets) out to clients, ring by ring. */
export const rollouts = sqliteTable(
  "rollouts",
  {
    id: text().primaryKey(),
    /** A release's code, or only new secrets on what runs. */
    kind: text({ enum: ["release", "secrets"] }).notNull(),
    releaseId: text("release_id").references(() => releases.id),
    /**
     * For a secrets rollout, the fingerprint of the shared secrets Secrets
     * Store held for each app when it started: JSON, `{"connect": "<hex>"}`
     * (src/rollout/shared-secrets.ts). What proves a rotation reached its
     * clients; null for a release rollout.
     */
    sharedSecrets: text("shared_secrets"),
    /** `waiting`: for a staff member's approval of the next ring. */
    status: text({
      enum: ["running", "waiting", "done", "failed", "cancelled"],
    }).notNull(),
    /** The ring it's rolling out to, or waiting after. */
    ring: integer().notNull().default(0),
    /** The staff member who started it. */
    startedBy: text("started_by").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    index("rollouts_status_idx").on(table.status),
    // The rollouts page lists the latest first (src/rollout/queries.ts).
    index("rollouts_created_idx").on(table.createdAt),
  ]
);

/** One client in a rollout, and how far it got. */
export const rolloutTargets = sqliteTable(
  "rollout_targets",
  {
    rolloutId: text("rollout_id")
      .notNull()
      .references(() => rollouts.id),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id),
    ring: integer().notNull(),
    /**
     * `pending` until its first step starts, claimed or not; `skipped`: on
     * the release already, pinned to another, or the rollout cancelled
     * before anything of it started; `stopped`: the rollout cancelled
     * after something had.
     */
    status: text({
      enum: [
        "pending",
        "deploying",
        "done",
        "failed",
        "rolled_back",
        "skipped",
        "stopped",
      ],
    })
      .notNull()
      .default("pending"),
    /** Why it failed or was skipped: a code, never a token or a response body. */
    error: text(),
    /** The client's deploy of the release, once the rollout started it. */
    deployId: text("deploy_id"),
    /**
     * What the client ran before the rollout reached it, which a rollback
     * restores: JSON (`PreviousRun`, src/rollout/targets.ts). For a
     * retry of a rollout that never finished the client, or a client left
     * between releases, what it ran before that one
     * (`unfinishedPrevious`).
     */
    previous: text(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.rolloutId, table.clientId] }),
    index("rollout_targets_client_idx").on(table.clientId),
  ]
);

/**
 * A client's deployment config (sign-in, model gateway), one row
 * per setting. Never a secret: those go straight to the client's Worker.
 */
export const settings = sqliteTable(
  "settings",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id),
    key: text().notNull(),
    /** JSON. */
    value: text().notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.key] })]
);

/**
 * A secret of a client's own that can't be derived, such as its Teams
 * bot's client secret, minted in the client's own Entra
 * (src/deploy/sealed-secrets.ts): sealed with a key derived from
 * `CLIENT_KEY`, which is in Secrets Store and never here, and opened only
 * to give it to the client's own Worker at deploy. Never read back to
 * anyone: only `setAt` and `setBy` are ever shown.
 */
export const clientSealedSecrets = sqliteTable(
  "client_sealed_secrets",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id),
    /** The Worker secret it becomes, such as `TEAMS_BOT_SECRET`. */
    name: text({
      enum: ["TEAMS_BOT_SECRET", "SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
    }).notNull(),
    /** AES-256-GCM, bound to the client and the name: `v1.<iv>.<ciphertext>`, base64. */
    sealed: text().notNull(),
    /** The staff member who last set it. */
    setBy: text("set_by").notNull(),
    setAt: timestamp("set_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.name] })]
);

/**
 * When each client's core last answered the admin's read of its admin
 * snapshot (src/clients/admin.ts), and why its latest read failed. Never
 * the snapshot or anything in it: the admin holds no client data, so a
 * client that doesn't answer is shown as not reachable since then, not
 * from a copy.
 */
export const clientAdminReads = sqliteTable("client_admin_reads", {
  clientId: text("client_id")
    .primaryKey()
    .references(() => clients.id),
  /** When its core last answered; null before it ever did. */
  lastAnsweredAt: timestamp("last_answered_at"),
  /** Why the latest read failed, as a code (`AdminReadError`); null when it answered. */
  error: text(),
  /** When it was last asked. */
  askedAt: timestamp("asked_at").notNull(),
});

/**
 * Grasp staff, as Access names them. Access decides who reaches the admin;
 * this lists who may be granted staff access in a client's deployment.
 */
export const staff = sqliteTable("staff", {
  email: text().primaryKey(),
  name: text().notNull(),
  /** Their Entra object id, which staff sessions in client deployments name. */
  entraOid: text("entra_oid"),
  addedAt: timestamp("added_at").notNull(),
});

/**
 * Every admin action, written in the same batch as the change it records
 * (`act` and `actIfChanged`, src/db/act.ts). Append-only; identifiers only, never secrets or
 * content (threat model R16, R17).
 */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text().primaryKey(),
    at: timestamp("at").notNull(),
    /** The staff member's email, or `system` for the admin's own jobs. */
    actor: text().notNull(),
    /** A dotted verb, such as `client.create`. */
    action: text().notNull(),
    /** The client it concerns, if any. */
    clientId: text("client_id"),
    /** What it acted on within that client, such as a release or rollout id. */
    target: text(),
    /** Identifiers and counts: JSON, never content. */
    detail: text(),
  },
  (table) => [
    index("audit_events_at_idx").on(table.at),
    index("audit_events_client_idx").on(table.clientId, table.at),
  ]
);

/**
 * Where clients run: a Cloudflare account (a Workers for Platforms
 * namespace in it, or ordinary Workers) or a host running plain workerd
 * (src/hosting/). Several clients may share one; their resources stay
 * apart (`clientResources`). Never a secret or a credential.
 */
export const hostingDestinations = sqliteTable("hosting_destinations", {
  /** Staff's name for it, such as `eu-production`. */
  id: text().primaryKey(),
  kind: text({
    enum: ["workers_for_platforms", "dedicated", "workerd"],
  }).notNull(),
  /** Its Cloudflare account; null for workerd. */
  accountId: text("account_id"),
  /** Its Workers for Platforms dispatch namespace; null otherwise. */
  namespace: text(),
  /** The hosting policies it may serve, by id: JSON (src/hosting/policy.ts). */
  policies: text().notNull(),
  /**
   * What staff verified it does, each with its evidence: JSON
   * (`destinationCapabilitiesSchema`, src/hosting/policy.ts). A capability
   * it doesn't list is unknown, which no policy accepts.
   */
  capabilities: text().notNull(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/**
 * Every capability of a destination as staff declared it, each time they
 * saved it (src/hosting/inventory.ts): written in the same batch as the
 * destination, never updated or deleted. A save records every capability,
 * the ones it doesn't list as `unknown`, so a destination's latest row per
 * capability is what its `capabilities` say. The evidence as it parsed
 * (`evidenceSchema`, src/hosting/policy.ts), flattened.
 */
export const destinationCapabilityEvidence = sqliteTable(
  "destination_capability_evidence",
  {
    /** Rising: the order the declarations were saved in. */
    id: integer().primaryKey({ autoIncrement: true }),
    destinationId: text("destination_id")
      .notNull()
      .references(() => hostingDestinations.id),
    /** A capability (src/hosting/policy.ts). */
    capability: text().notNull(),
    /** `unknown`: the save didn't list it, and it has no evidence. */
    status: text({ enum: ["verified", "unsupported", "unknown"] }).notNull(),
    /** What the evidence was observed against; null when unknown. */
    subjectKind: text("subject_kind", {
      enum: ["source", "candidate", "release", "profile"],
    }),
    subjectId: text("subject_id"),
    procedure: text(),
    observedAt: timestamp("observed_at"),
    /** Who the evidence says observed it. */
    recordedBy: text("recorded_by"),
    /** Where the full record is. */
    record: text(),
    /** Who saved it: a staff member's email, or `system`. */
    declaredBy: text("declared_by").notNull(),
    declaredAt: timestamp("declared_at").notNull(),
  },
  (table) => [
    index("destination_capability_evidence_idx").on(
      table.destinationId,
      table.capability,
      table.id
    ),
  ]
);

/**
 * The destination a client runs in and the policy it runs under, and the
 * opaque deployment id its resources' names are made from. Set once:
 * moving a client elsewhere, or to another jurisdiction, is a migration
 * to new resources, never a change of this row (src/hosting/inventory.ts).
 */
export const clientPlacements = sqliteTable("client_placements", {
  clientId: text("client_id")
    .primaryKey()
    .references(() => clients.id),
  /** Random, never the client's id: a client's rename renames nothing. */
  deploymentId: text("deployment_id").notNull().unique(),
  destinationId: text("destination_id")
    .notNull()
    .references(() => hostingDestinations.id),
  policyId: text("policy_id").notNull(),
  placedBy: text("placed_by").notNull(),
  placedAt: timestamp("placed_at").notNull(),
});

/**
 * A client's private resources, one per logical role a release names
 * (src/hosting/inventory.ts): what a deploy binds its Workers to, and
 * what an export of the client enumerates. A physical name is the
 * destination's, so two clients in one destination never share one.
 */
export const clientResources = sqliteTable(
  "client_resources",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id),
    /** The release's name for it, such as `d1:grasp-os-core`. */
    role: text().notNull(),
    kind: text({
      enum: [
        "worker_script",
        "d1_database",
        "r2_bucket",
        "durable_object_class",
      ],
    }).notNull(),
    destinationId: text("destination_id")
      .notNull()
      .references(() => hostingDestinations.id),
    /** Its name in the destination, made from the deployment id. */
    physicalName: text("physical_name").notNull(),
    /** The provider's id for it once observed, such as a D1 database's uuid. */
    providerId: text("provider_id"),
    /**
     * The run that last asked the provider to create it; null until one
     * did. A resource found under its name is adopted only after such a
     * request (a create whose answer was lost), never otherwise
     * (src/hosting/provision.ts).
     */
    createRequestedBy: text("create_requested_by"),
    /** Where its data is kept, as its policy set it at allocation. */
    jurisdiction: text().notNull(),
    /** The deployment id that owns it: nothing else may adopt it. */
    owner: text().notNull(),
    /** The allocation that recorded it. */
    operationId: text("operation_id").notNull(),
    /**
     * `tombstoned`: a Durable Object class a release deleted. Kept, so an
     * export accounts for every class the client ever had.
     */
    lifecycle: text({ enum: ["allocated", "tombstoned"] })
      .notNull()
      .default("allocated"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.role] }),
    uniqueIndex("client_resources_physical_idx").on(
      table.destinationId,
      table.kind,
      table.physicalName
    ),
  ]
);

/**
 * Provisioning a placed client (spec 40.2, src/hosting/operation.ts): one
 * operation per client, however often it's retried, and how far it got.
 * Every step can run again, so a retry resumes it from the start of the
 * step it stopped in, and nothing is created twice or replaced.
 */
export const clientProvisions = sqliteTable("client_provisions", {
  id: text().primaryKey(),
  /** One operation per client: a retry resumes it, never starts another. */
  clientId: text("client_id")
    .notNull()
    .unique()
    .references(() => clients.id),
  /** The release it provisions: fixed for the operation. */
  releaseId: text("release_id")
    .notNull()
    .references(() => releases.id),
  status: text({ enum: ["running", "failed", "done"] }).notNull(),
  /** The last step that finished, such as `resources`; null before the first. */
  step: text(),
  /** Why it stopped: an error code staff act on, never a message or a response body. */
  error: text(),
  /**
   * What its steps observed, to resume without repeating them: JSON
   * (`progressSchema`, src/hosting/operation.ts): each Worker's upload
   * fingerprint, its delivered secrets' fingerprint, the core origin its
   * probe passed at, and its sending domain's zone. Fingerprints are keyed hashes: they tell nothing
   * of a secret.
   */
  progress: text(),
  /** The runner that last recorded a step: a Workflow instance (src/runners.ts). */
  runId: text("run_id"),
  /** The staff member who started it. */
  startedBy: text("started_by").notNull(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/**
 * An integration Grasp's agent builds into the platform: one row per app,
 * shared by every company that asked for it (src/builds/builds.ts). It
 * moves forward through its stages, each move a conditional write naming
 * the stage it leaves, audited in the same batch, so a late or repeated
 * event never moves it back. Never an app credential, a company's data or
 * anything the agent read: those stay in Secrets Store, the company's
 * deployment and the agent's session.
 */
export const integrationBuilds = sqliteTable("integration_builds", {
  /** The app's connector name: its package's, `packages/connectors/<app>`. */
  app: text().primaryKey(),
  /** The app as people name it, such as `Personio`. */
  name: text().notNull(),
  stage: text({
    enum: [
      "asked",
      "researching",
      "plan_ready",
      "credentials",
      "writing",
      "in_review",
      "merged",
      "needs_person",
    ],
  }).notNull(),
  /** The stage it was in when it came to need a person; null otherwise. */
  stoppedAt: text("stopped_at"),
  /** Why it needs a person, as a code; null otherwise. */
  reason: text(),
  /** Its build's Workflow instance (src/builds/workflow.ts). */
  runId: text("run_id").notNull(),
  /**
   * The agent's plan, while it waits for a person or once approved: JSON
   * (`buildPlanSchema`, src/builds/plan.ts). Its hosts are the only ones
   * the connector's manifest may name.
   */
  plan: text(),
  /** How many plans the agent has written: a sent-back plan starts the next round. */
  planRound: integer("plan_round").notNull().default(0),
  /** What the person who sent the last plan back asked for; null otherwise. */
  planNote: text("plan_note"),
  /** The staff member who approved the plan. */
  approvedBy: text("approved_by"),
  /** The branch it is written on, `feat/connector-<app>`, once it has a pull request. */
  branch: text(),
  /** Its pull request's number in grasplabs/work. */
  pullRequest: integer("pull_request"),
  /** The commit its pull request was squash-merged as, on `main`. */
  mergeCommitSha: text("merge_commit_sha"),
  /** The staff member who confirmed Build it. */
  requestedBy: text("requested_by").notNull(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/**
 * When the admin last told staff of each kind of alert about each client
 * (src/alerts.ts): an alert of the same client and kind within its window
 * isn't sent again, so a storm is one message. Nothing of what an alert
 * said is kept.
 */
export const staffAlerts = sqliteTable(
  "staff_alerts",
  {
    clientId: text("client_id").notNull(),
    /**
     * The alert's kind, such as `test`, and its subject when it has one:
     * `teams_bot_secret_expiring/2027-04-30/30` (src/alerts.ts).
     */
    kind: text().notNull(),
    sentAt: timestamp("sent_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.kind] })]
);

/**
 * What the admin's watch last read of how each client's Stephen fares
 * (src/clients/watch.ts): the signals it reads from the client's admin
 * snapshot, as JSON, and when. Counts only. One row a client, replaced
 * at each read that answered.
 */
export const clientWatch = sqliteTable("client_watch", {
  clientId: text("client_id")
    .primaryKey()
    .references(() => clients.id),
  readAt: timestamp("read_at").notNull(),
  /** `WatchedSignals` (src/clients/watch.ts), as JSON. */
  signals: text().notNull(),
});
