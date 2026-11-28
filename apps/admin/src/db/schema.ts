/**
 * Admin D1 schema: intent and history only. What runs in a client's
 * account (live Worker versions, secrets) is read from that account; the
 * token that reaches client accounts lives in Secrets Store, never here
 * (threat model R17).
 */

import "@tanstack/react-start/server-only";
import { flowPresetNames } from "@grasp-os/shared/onboarding-flow";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { alertChannelIds } from "../alerts/alert-channels.ts";
import { channelIds } from "../rollout/channel-ids.ts";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

/** A release CI built and published, imported once its blobs checked out. */
export const releases = sqliteTable("releases", {
  /** `YY.MM.N` (@grasp-os/shared/release-id); the commit is `commitSha`. */
  id: text().primaryKey(),
  commitSha: text("commit_sha").notNull(),
  /** The release's manifest, as CI wrote it: JSON. */
  manifest: text().notNull(),
  /** The manifest's sha256, hex. */
  manifestSha256: text("manifest_sha256").notNull(),
  builtAt: timestamp("built_at").notNull(),
  importedAt: timestamp("imported_at").notNull(),
  /**
   * When its bundle files left the releases bucket: a release never
   * promoted past Edge, 14 days on (src/releases/retention.ts). Null while
   * they're kept; the record itself is kept for good.
   */
  bundleDeletedAt: timestamp("bundle_deleted_at"),
});

/**
 * Which blobs each published release names (src/releases/blobs.ts): one
 * row a blob, written when the import reads the release's manifest,
 * imported yet or not, and replaced when that manifest is. Blobs are content-addressed and shared, so a blob
 * may leave the releases bucket only once no release still holding its
 * bundle names it (src/releases/retention.ts): an indexed look-up, never
 * a read of every manifest. No foreign key: a release still being
 * imported has no record yet, and its blobs are kept all the same.
 */
export const releaseBlobs = sqliteTable(
  "release_blobs",
  {
    releaseId: text("release_id").notNull(),
    blobKey: text("blob_key").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.releaseId, table.blobKey] }),
    index("release_blobs_blob_idx").on(table.blobKey),
  ]
);

/**
 * A published release the import has tried and not imported yet, and when
 * it tries it again (src/releases/import.ts): each attempt is counted as
 * it starts, so one a run died in counts too. Gone once it's imported.
 */
export const releaseImportFailures = sqliteTable("release_import_failures", {
  /** The release's id, as its R2 prefix names it. */
  releaseId: text("release_id").primaryKey(),
  /** Attempts so far: the wait before the next one doubles each time. */
  attempts: integer().notNull(),
  /** When the last attempt started. */
  failedAt: timestamp("failed_at").notNull(),
  nextAttemptAt: timestamp("next_attempt_at").notNull(),
});

/**
 * How far the import has checked a published release it didn't finish,
 * as a run's requests ran out or an attempt failed partway
 * (src/releases/import.ts): the first `verifiedBlobs` of them, in its
 * manifest's order, for the manifest with that sha256, where the next
 * attempt goes on. Gone once it's imported.
 */
export const releaseImportProgress = sqliteTable("release_import_progress", {
  releaseId: text("release_id").primaryKey(),
  /** The manifest the checked blobs are its: another starts again. */
  manifestSha256: text("manifest_sha256").notNull(),
  verifiedBlobs: integer("verified_blobs").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/**
 * The release each channel points at (src/rollout/channels.ts): the
 * desired state the rollout pass deploys (src/rollout/scheduler.ts). No
 * row yet: no release promoted to it. How it got there is in the audit
 * log (`channel.promote`).
 */
export const channels = sqliteTable("channels", {
  id: text({ enum: channelIds }).primaryKey(),
  releaseId: text("release_id")
    .notNull()
    .references(() => releases.id),
  updatedAt: timestamp("updated_at").notNull(),
  /**
   * Why nothing new deploys on the channel: its rollout's halt reason
   * (src/rollout/scheduler.ts), or, from an older admin, an error code;
   * null once it's resumed or the channel moves. Shown in "Needs Grasp
   * today" at each of its organizations. Kept while an older admin may
   * read it.
   */
  stoppedBy: text("stopped_by"),
});

/**
 * Who runs a piece of the admin's background work now (src/db/lease.ts):
 * one row a lease while it's held, taken with a compare-and-set, so runs
 * that overlap never act side by side. Taken over only once it expired,
 * from a run that died before giving it back. Named for its first lease,
 * the reconciler's.
 */
export const leases = sqliteTable("reconciler_lease", {
  /** The lease: `reconciler` (src/rollout/scheduler.ts), `releases` (src/releases/import.ts) or `alerts` (src/alerts/alert.ts). */
  id: text().primaryKey(),
  /** The run holding it: a random id of its own. */
  holder: text().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});

/**
 * One channel's rollout of one release: started by a promotion, a
 * rollback or an import, it takes the channel's organizations to the
 * release, smallest to largest, the late ones last (src/rollout/plan.ts).
 * It halts by itself when 3 have failed since it started or was last
 * resumed; only staff resume it. Done once every organization
 * on the channel runs the release; superseded once the channel points at
 * another. At most one per channel is running or halted.
 */
export const rollouts = sqliteTable(
  "rollouts",
  {
    /** A random id of its own. */
    id: text().primaryKey(),
    channel: text({ enum: channelIds }).notNull(),
    releaseId: text("release_id")
      .notNull()
      .references(() => releases.id),
    status: text({
      enum: ["running", "halted", "done", "superseded"],
    }).notNull(),
    /**
     * Who approved it: the staff member who promoted or rolled back, or
     * `system` for an import's Edge rollout.
     */
    startedBy: text("started_by").notNull(),
    startedAt: timestamp("started_at").notNull(),
    /** When it was done or superseded; null while it runs or is halted. */
    endedAt: timestamp("ended_at"),
    /**
     * Why it halted: `failed`, 3 failed. Null while it never halted.
     * `own_failed` is no longer written: a later contract can drop it.
     */
    haltedReason: text("halted_reason", { enum: ["own_failed", "failed"] }),
    /** When staff last resumed it; null while they never did. */
    resumedAt: timestamp("resumed_at"),
    /** Organizations it took to the release. */
    done: integer().notNull().default(0),
    /** Organizations it failed on since it started or was last resumed. */
    failed: integer().notNull().default(0),
  },
  (table) => [
    uniqueIndex("rollouts_live_channel_idx")
      .on(table.channel)
      .where(sql`${table.status} in ('running', 'halted')`),
    index("rollouts_release_channel_idx").on(table.releaseId, table.channel),
  ]
);

/**
 * What is left of the deployer token's Cloudflare API budget, as the
 * API's last `Ratelimit` header said, and until when nothing may start
 * after a 429. One row a token: every client of a stage is deployed with
 * the one token, so one budget covers the whole fleet.
 */
export const apiBudget = sqliteTable("api_budget", {
  /** The token, by its binding: `DEPLOYER_API_TOKEN`. */
  token: text().primaryKey(),
  /** Requests left in the window. */
  remaining: integer().notNull(),
  /** When the window resets. */
  resetAt: timestamp("reset_at").notNull(),
  /** Until when nothing may start, after a 429; null while not blocked. */
  blockedUntil: timestamp("blocked_until"),
  updatedAt: timestamp("updated_at").notNull(),
});

/**
 * A client: one deployment of Grasp OS, placed in a hosting destination
 * (src/hosting/), where its operation provisions and releases it.
 */
export const clients = sqliteTable(
  "clients",
  {
    /** The client's slug: its subdomain, `<slug>.<domain>`. */
    id: text().primaryKey(),
    name: text().notNull(),
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
     * The release channel it follows (src/rollout/channels.ts): a release
     * promoted to it is deployed to it, unless it's pinned.
     */
    channel: text({ enum: channelIds }).notNull().default("stable"),
    status: text({ enum: ["provisioning", "active", "offboarded"] })
      .notNull()
      .default("provisioning"),
    /**
     * When staff offboarded it (src/hosting/offboarding.ts): its hostname
     * left the router's map then, and its resources may be deleted once
     * the retention window from here is over. Null while it isn't.
     */
    offboardedAt: timestamp("offboarded_at"),
    /** The staff member who added it (src/provision/). */
    createdBy: text("created_by"),
    /**
     * How its people sign in, as staff gave it when provisioning: JSON
     * (`clientSignInSchema`, src/clients/sign-in-schema.ts), the client's own
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
     * Grasp's staff window, while staff opened one: JSON
     * (`staffWindowSchema`, src/deploy/core-config.ts), when it opened,
     * until when, and its scope. Every deploy makes core's `SIGN_IN.staff`
     * from it, which the kickoff and staff's commands need; null while
     * none is open.
     */
    staffWindow: text("staff_window"),
    /**
     * When staff last changed what a deploy sets on its core: its sign-in
     * or a setting (src/clients/settings.ts). A rollout deploys a client
     * whose latest done deploy started before this, even on the release
     * already (src/rollout/targets.ts); null while nothing changed.
     */
    configChangedAt: timestamp("config_changed_at"),
    /**
     * Where it runs: Grasp's cloud, or its own premises
     * (src/hosting/organization.ts). Fixed once it is provisioned.
     */
    hosting: text({ enum: ["grasp_cloud", "on_prem"] })
      .notNull()
      .default("grasp_cloud"),
    /**
     * Where Grasp Cloud keeps its data: the EU jurisdiction, or none. Every
     * database, bucket and Durable Object is created there; fixed once it
     * is provisioned.
     */
    jurisdiction: text({ enum: ["eu", "none"] })
      .notNull()
      .default("eu"),
    /**
     * The client's customer in Grasp's Stripe (`cus_...`), as someone at
     * Grasp linked it by hand (src/billing/link.ts): never matched by name
     * or email, so the admin never shows one company another's invoices.
     * Only the id is kept; what Stripe holds is read each time
     * (src/billing/stripe.ts). Null until it is linked.
     */
    stripeCustomerId: text("stripe_customer_id"),
    /**
     * The client's company in Grasp's Attio: its record's id, as someone at
     * Grasp linked it by hand (src/crm/link.ts), never matched by name or
     * domain. Only the id is kept; the company, its people and its deals
     * are read each time (src/crm/attio.ts). Null until it is linked.
     */
    attioCompanyId: text("attio_company_id"),
    /**
     * The onboarding its company starts with, as staff chose it when they
     * added it: the name of one of the flows staff start from
     * (`flowPresetNames`, @grasp-os/shared/onboarding-flow). Every deploy
     * gives it to core as `ONBOARDING_START`, which core reads once, as
     * its onboarding is first kept; what the company goes through since
     * is on its Flow page. Null for one added before this was kept, or
     * with the whole onboarding.
     */
    startingFlow: text("starting_flow", { enum: flowPresetNames }),
    /**
     * When it was added, where staff added it with an onboarding: its
     * deployment then starts closed to everyone but its admins, without
     * staff closing it first. Every deploy gives it to core as
     * `ONBOARDING_CLOSED_FROM`, which core reads only while its gate was
     * never moved. Null for one added before this was kept, which started
     * open, and for one that goes through no onboarding.
     */
    closedFrom: timestamp("closed_from"),
    /**
     * When a rollout reaches it: `normal`, smallest first; `late`, last
     * (src/rollout/plan.ts). `own` reads as `normal` and is no longer
     * offered: a later contract can drop it.
     */
    rolloutGroup: text("rollout_group", { enum: ["own", "normal", "late"] })
      .notNull()
      .default("normal"),
    /** The release it stays on while pinned: promotions skip it. */
    pinnedReleaseId: text("pinned_release_id").references(() => releases.id),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  // What a promotion reaches: the active clients of a channel
  // (src/rollout/channels.ts).
  (table) => [
    index("clients_status_channel_idx").on(table.status, table.channel),
  ]
);

/**
 * The runner that's a client's current one (src/runners.ts): the
 * only one that may change what its account runs. A provisioning run (a
 * run per attempt), a rollout while it deploys the client (its run), or
 * applying its settings (its run).
 * Each claims it with one conditional write naming the runner it
 * replaces, so however many act at once, one wins: the single runner a
 * client's deploy relies on. No foreign key: a provisioning run is
 * claimed before its account step records the client.
 */
export const clientRuns = sqliteTable("client_runs", {
  /** The client's id, as it will be recorded. */
  clientId: text("client_id").primaryKey(),
  /**
   * The runner's id: a provisioning attempt's run
   * (`<clientId>-<random>`), a rollout's (the rollout's id), or applying
   * the client's settings
   * (`apply-<random>`, src/clients/apply.ts).
   */
  runId: text("run_id").notNull(),
  /** When it was claimed: a run not created yet counts as starting for a while. */
  claimedAt: timestamp("claimed_at").notNull(),
  /**
   * Which Workflow the runner is an instance of: `provision_placed`
   * provisions a client placed in a hosting destination
   * (src/hosting/workflow.ts); `rollout` takes it to a release, a step a
   * phase (src/rollout/org-rollout.ts); `deploy`, the same in one step
   * (src/rollout/deploy.ts), until that goes.
   */
  kind: text({
    enum: ["deploy", "apply", "provision_placed", "rollout"],
  }).notNull(),
  /**
   * The runner's attempt that holds the client, for a runner on Workerflow
   * (src/runners.ts, `takeAttempt`): an attempt that timed out goes on
   * beside its retry under the same run, and only the latest may act. 0
   * for a runner that doesn't fence its attempts.
   */
  attempt: integer().notNull().default(0),
  /**
   * The step that attempt is of (Workerflow's idempotency key for it):
   * with `attempt`, which attempt of which run's step holds the client
   * (src/runners.ts, `takeAttempt`). Null until one takes it.
   */
  attemptKey: text("attempt_key"),
  /**
   * The ordinal of the step that attempt is of, in its run: with
   * `attempt`, the fence a later step of the same run passes too
   * (src/runners.ts, `takeAttempt`). 0 for a runner that doesn't fence its
   * steps.
   */
  step: integer().notNull().default(0),
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
 * Each client's last deploy by the rollout pass (src/rollout/scheduler.ts),
 * and its claim while it runs: a deploy starts only by replacing the row
 * as it was read (its `runId`), in the same batch as the client's runner
 * claim (src/runners.ts), so two ticks never deploy one client twice.
 * The lease is the run's own life: a `deploying` row whose run ended
 * without saying so is settled as failed on the next tick.
 */
export const clientDeploys = sqliteTable("client_deploys", {
  clientId: text("client_id")
    .primaryKey()
    .references(() => clients.id),
  /** The release it deploys or deployed: the client's target then. */
  releaseId: text("release_id")
    .notNull()
    .references(() => releases.id),
  /** The deploy's run (src/rollout/deploy.ts). */
  runId: text("run_id").notNull(),
  status: text({ enum: ["deploying", "done", "failed"] }).notNull(),
  /** Why it failed: a code, never a message or a response body. */
  error: text(),
  startedAt: timestamp("started_at").notNull(),
  /** When it ended; null while it runs. */
  endedAt: timestamp("ended_at"),
  /**
   * The rollout it deploys for; null for a deploy that brings a client
   * back to its target without a release change (settings, secrets, a
   * pin), which never counts toward a rollout.
   */
  rolloutId: text("rollout_id").references(() => rollouts.id),
  /**
   * How many of the client's deploys for this rollout, right before this
   * one, ended in a platform fault (a 429, a run never created): after a
   * few in a row the rollout sets the client aside, alerted, and moves on
   * (src/rollout/plan.ts). 0 outside a rollout.
   */
  platformFaults: integer("platform_faults").notNull().default(0),
});

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
    // A channel's history, and which channels a release was on
    // (src/rollout/channels.ts).
    index("audit_events_action_idx").on(table.action, table.target),
  ]
);

/**
 * Where clients run: a Workers for Platforms namespace in a Cloudflare
 * account, one per stage (src/hosting/placement.ts,
 * `ensureStageDestination`). Every client of the stage shares it; their
 * resources stay apart (`clientResources`). Never a secret or a credential.
 */
export const hostingDestinations = sqliteTable("hosting_destinations", {
  /** Its name, such as `workers-for-platforms-production`. */
  id: text().primaryKey(),
  /** Its Cloudflare account. */
  accountId: text("account_id"),
  /** Its Workers for Platforms dispatch namespace. */
  namespace: text(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/**
 * The destination a client runs in, and the opaque deployment id its
 * resources' names are made from. Set once:
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
    /**
     * When an explicit deletion removed it from its destination
     * (src/hosting/offboarding.ts); null while it's there, or was never
     * made. Kept, so the record says what the client had and when it went.
     */
    deletedAt: timestamp("deleted_at"),
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
  /**
   * The release it provisions, or the later one (or the one before) a
   * release or rollback took it to: fixed while it runs.
   */
  releaseId: text("release_id")
    .notNull()
    .references(() => releases.id),
  /**
   * The release the client ran before the latest release or rollback
   * started (src/hosting/operation.ts): what a rollback takes it back to;
   * null before its first release after provisioning.
   */
  previousReleaseId: text("previous_release_id").references(() => releases.id),
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
  /** The runner it was started for, then the one that last recorded a step: a run (src/runners.ts). */
  runId: text("run_id"),
  /**
   * The calls to the client's Workers still on their way, by sender (a
   * runner's attempt at a step): JSON, each sender's change and when it
   * sent (src/hosting/operation.ts, `sendHolding`). Apart from `progress`,
   * which every step rewrites: a mark stays until its own sender clears it,
   * or it ages out.
   */
  sending: text(),
  /**
   * Counts every change started on the client: each release, run again
   * and rollback raises it (src/hosting/operation.ts). What a rollout or
   * rollback reads to know its change is still the client's latest,
   * rather than comparing releases, which a later change can return to.
   */
  change: integer().notNull().default(0),
  /**
   * What the change started is, as the client's core records it
   * (`platform.updated`): a release, or new settings or secrets, or both,
   * on the release it runs. Null before its first change.
   */
  what: text({
    enum: ["release", "secrets", "settings", "settings_and_secrets"],
  }),
  /** The staff member who started it. */
  startedBy: text("started_by").notNull(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

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

/**
 * Whether each alert channel is on (src/alerts/alert.ts), as staff set it
 * on Platform's Maintenance page: one without a row is off. How it got
 * there is in the audit log (`alerts.on`, `alerts.off`).
 */
export const alertChannels = sqliteTable("alert_channels", {
  channel: text({ enum: alertChannelIds }).primaryKey(),
  on: integer({ mode: "boolean" }).notNull(),
});

/**
 * What alerts staff while it fails, one row a thing (src/alerts/alert.ts):
 * whether it fails now, the event that last changed that, the channels
 * still to tell of the change, and those its failure reached. A change is
 * told once; the same state again changes nothing, so the every-minute
 * cron never repeats it. Gone once it recovered and every channel its
 * failure reached was told, or at once when its failure reached none.
 */
export const alerts = sqliteTable("alerts", {
  /** What it is about, such as `import:<release>` or `deploy:<client>`. */
  key: text().primaryKey(),
  failing: integer({ mode: "boolean" }).notNull(),
  /** `AlertEvent` (src/alerts/alert.ts), as JSON: identifiers and a code only. */
  event: text().notNull(),
  changedAt: timestamp("changed_at").notNull(),
  /** The channels still to tell, as a JSON array, until each took it or the attempts ran out. */
  pending: text().notNull(),
  /** Delivery passes that tried since the change. */
  attempts: integer().notNull(),
  /** The channels that took its failure, as a JSON array: those its recovery goes to. */
  told: text().notNull(),
});
