/**
 * A client's private resources in its hosting destination (spec 37.2, 39):
 * which destination and policy it's placed under, and one inventory row per
 * logical role a release names, mapped to a physical resource no other
 * client has. Several clients may share a destination; nothing of theirs
 * is shared but the destination itself.
 *
 * Allocation records what a client's resources are called before anything
 * is created, so creating them (provisioning) can be retried and recovered
 * by name and owner, and no resource is adopted because its name happens
 * to match. Rendering maps a release's bindings onto one client's
 * inventory, and refuses anything it can't map, before any upload.
 *
 * This is the target model, alongside the account-per-client deploy path
 * (src/deploy/), which doesn't read it yet: the real-account qualification
 * comes first.
 */
import type { ConnectGatewayProps } from "@grasp-os/shared/connect-gateway";
import { toHex } from "@grasp-os/shared/encoding";
import { clientsNamespace } from "@grasp-os/shared/names";
import type { Stage } from "@grasp-os/shared/names";
import { d1IdPlaceholder } from "@grasp-os/shared/release";
import type { ReleaseManifest, WorkerEntry } from "@grasp-os/shared/release";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";

import { act, actIfChanged } from "../db/act.ts";
import type { Actor, AdminDatabase } from "../db/act.ts";
import {
  clientPlacements,
  clientResources,
  destinationCapabilityEvidence,
  hostingDestinations,
  releases,
} from "../db/schema.ts";
import { holdsClient, stillHolds } from "../runners.ts";
import type { HeldClient } from "../runners.ts";
import {
  capabilities,
  destinationCapabilitiesSchema,
  hostingPolicies,
  hostingPolicyIdSchema,
  placementProblems,
} from "./policy.ts";
import type {
  DestinationCapabilities,
  Evidence,
  HostingPolicyId,
  Jurisdiction,
  PlacementProblem,
} from "./policy.ts";

export const inventoryErrorCodes = [
  /** No destination by that id. */
  "destination_unknown",
  /** The destination doesn't satisfy the policy, or doesn't serve it. */
  "placement_refused",
  /** A Workers for Platforms destination in another stage's namespace than the admin's own. */
  "destination_other_stage",
  /**
   * The client is placed elsewhere or under another policy: moving it is a
   * migration onto new resources, never a relabel.
   */
  "placement_changed",
  /** The client has no placement yet. */
  "not_placed",
  /** A release's bucket is outside the policy's jurisdiction. */
  "bucket_jurisdiction",
  /** A Durable Object migration the inventory can't follow without a decision (rename, transfer). */
  "unsupported_durable_object_migration",
  /** A recorded resource differs from what the release needs of that role. */
  "resource_conflict",
  /** A binding names a resource the client's inventory doesn't have (or hasn't observed). */
  "resource_missing",
  /** A resource that belongs to another client, deployment or destination. */
  "foreign_resource",
  /** A binding of a kind rendering doesn't map. */
  "unsupported_binding",
  /** A binding that would take the Workers' Durable Objects out of the EU-restricted namespace. */
  "durable_object_jurisdiction",
  /** A binding names a placeholder rendering doesn't fill. */
  "unknown_placeholder",
  /** The destination isn't one the admin creates resources in (workerd is set up by its operator). */
  "destination_unsupported",
  /** A resource exists under a recorded name, but no run of this client asked for it. */
  "unowned_resource",
  /** The provider reports a resource outside the jurisdiction the inventory records. */
  "resource_outside_jurisdiction",
  /** Another runner took the client over: this one changes nothing more. */
  "runner_replaced",
  /**
   * Evidence observed against something the admin can't check: a
   * release it hasn't imported, a commit no imported release was built
   * from, a candidate, or a runtime profile the destination doesn't run.
   */
  "evidence_subject_unknown",
] as const;

export type InventoryErrorCode = (typeof inventoryErrorCodes)[number];

/** Why placing, allocating or rendering stopped: a fixed code and identifiers only. */
export class InventoryError extends Error {
  readonly code: InventoryErrorCode;
  readonly problems: readonly PlacementProblem[];

  constructor(
    code: InventoryErrorCode,
    message: string,
    problems: readonly PlacementProblem[] = []
  ) {
    super(message);
    this.name = "InventoryError";
    this.code = code;
    this.problems = problems;
  }
}

export type ResourceKind = (typeof clientResources.kind.enumValues)[number];
export type ClientResource = typeof clientResources.$inferSelect;
export type ClientPlacement = typeof clientPlacements.$inferSelect;

type DestinationKind = (typeof hostingDestinations.kind.enumValues)[number];

/** A destination as staff record it. */
export interface DestinationInput {
  id: string;
  kind: DestinationKind;
  accountId: string | null;
  namespace: string | null;
  policies: readonly HostingPolicyId[];
  capabilities: DestinationCapabilities;
}

const destinationIdSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/u);

/**
 * The runtime profile core runs on in each kind of destination: the only
 * profile evidence about that destination may name. Cloudflare's, as the
 * deploy sets `RUNTIME_PROFILE` (src/deploy/core-config.ts), or plain
 * workerd's, which its operator runs.
 */
const runtimeProfiles = {
  workers_for_platforms: "cloudflare",
  dedicated: "cloudflare",
  workerd: "workerd",
} as const satisfies Record<DestinationKind, string>;

type Subject = Evidence["subject"];

/** Each capability `verified` lists, with what its evidence was observed against. */
const subjectsOf = (verified: DestinationCapabilities) =>
  Object.entries(verified).flatMap(([capability, entry]) =>
    entry === undefined ? [] : [{ capability, subject: entry.evidence.subject }]
  );

/** The ids of every subject of `kind` that `verified`'s evidence names. */
const idsOf = (
  verified: DestinationCapabilities,
  kind: Subject["kind"]
): string[] => [
  ...new Set(
    subjectsOf(verified)
      .filter(({ subject }) => subject.kind === kind)
      .map(({ subject }) => subject.id)
  ),
];

/** Which of `ids` name a release the admin imported. */
const importedReleases = async (
  db: AdminDatabase,
  ids: readonly string[]
): Promise<Set<string>> => {
  if (ids.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ id: releases.id })
    .from(releases)
    .where(inArray(releases.id, [...ids]));
  return new Set(rows.map(({ id }) => id));
};

/** Which of `commits` an imported release was built from. */
const builtCommits = async (
  db: AdminDatabase,
  commits: readonly string[]
): Promise<Set<string>> => {
  if (commits.length === 0) {
    return new Set();
  }
  const rows = await db
    .selectDistinct({ commitSha: releases.commitSha })
    .from(releases)
    .where(inArray(releases.commitSha, [...commits]));
  return new Set(rows.map(({ commitSha }) => commitSha));
};

/**
 * Throws unless the evidence in `verified`, for a destination of `kind`,
 * names only subjects the admin knows: a release it imported, a commit
 * one was built from, or the destination's own runtime profile. An
 * untrusted report of success, naming anything else, proves nothing about
 * what runs. A candidate is never known: the admin imports releases,
 * not candidates, so what was observed on one is recorded against the
 * release it became.
 */
const assertSubjectsKnown = async (
  db: AdminDatabase,
  kind: DestinationKind,
  verified: DestinationCapabilities
): Promise<void> => {
  const imported = await importedReleases(db, idsOf(verified, "release"));
  const built = await builtCommits(db, idsOf(verified, "source"));
  const known: Record<Subject["kind"], (id: string) => boolean> = {
    release: (id) => imported.has(id),
    source: (id) => built.has(id),
    profile: (id) => id === runtimeProfiles[kind],
    candidate: () => false,
  };
  const unknown = subjectsOf(verified).find(
    ({ subject }) => !known[subject.kind](subject.id)
  );
  if (unknown !== undefined) {
    throw new InventoryError(
      "evidence_subject_unknown",
      `${unknown.capability}'s evidence names ${unknown.subject.kind} ${unknown.subject.id}, which the admin can't check`
    );
  }
};

/**
 * Where `evidence`'s full record is, as the audit log keeps it: without
 * credentials, query or fragment, which a link to a test run may carry.
 */
const recordOf = (evidence: Evidence): string => {
  const url = new URL(evidence.record);
  return `${url.origin}${url.pathname}`;
};

/** The audit detail of each capability `verified` lists: its status, subject and record. */
const evidenceDetail = (
  verified: DestinationCapabilities
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(verified).flatMap(([capability, entry]) =>
      entry === undefined
        ? []
        : [
            [
              `evidence.${capability}`,
              `${entry.status} ${entry.evidence.subject.kind}:${entry.evidence.subject.id} ${recordOf(entry.evidence)}`,
            ],
          ]
    )
  );

/**
 * Records destination `input`, or replaces what it says about one: its
 * capabilities are re-verified as staff record new evidence. Placing a
 * client checks them again, so a capability withdrawn here stops the next
 * allocation for every client in it. Evidence must name a subject the
 * admin knows, and every capability's declaration, the unlisted ones as
 * unknown, is kept (`capabilityEvidence`). A Workers for Platforms
 * destination must be in the admin's own `stage`'s clients' namespace
 * (`destination_other_stage`): a staging admin never records one among
 * production's clients, nor production's among staging's.
 */
export const saveDestination = async (
  db: AdminDatabase,
  actor: Actor,
  input: DestinationInput,
  stage: Stage
): Promise<void> => {
  destinationIdSchema.parse(input.id);
  if (
    input.kind === "workers_for_platforms" &&
    input.namespace !== clientsNamespace(stage)
  ) {
    throw new InventoryError(
      "destination_other_stage",
      `${input.id}'s namespace ${String(input.namespace)} isn't this admin's own, ${clientsNamespace(stage)}`
    );
  }
  const policies = z.array(hostingPolicyIdSchema).parse(input.policies);
  const verified = destinationCapabilitiesSchema.parse(input.capabilities);
  await assertSubjectsKnown(db, input.kind, verified);
  const now = new Date();
  const values = {
    kind: input.kind,
    accountId: input.accountId,
    namespace: input.namespace,
    policies: JSON.stringify(policies),
    capabilities: JSON.stringify(verified),
    updatedAt: now,
  };
  // An insert per capability: a D1 statement binds at most 100 values.
  const declarations = capabilities.map((capability) => {
    const entry = verified[capability];
    return db.insert(destinationCapabilityEvidence).values({
      destinationId: input.id,
      capability,
      status: entry?.status ?? "unknown",
      subjectKind: entry?.evidence.subject.kind ?? null,
      subjectId: entry?.evidence.subject.id ?? null,
      procedure: entry?.evidence.procedure ?? null,
      observedAt:
        entry === undefined ? null : new Date(entry.evidence.observedAt),
      recordedBy: entry?.evidence.recordedBy ?? null,
      record: entry?.evidence.record ?? null,
      declaredBy: actor === "system" ? actor : actor.email,
      declaredAt: now,
    });
  });
  await act(
    db,
    actor,
    [
      db
        .insert(hostingDestinations)
        .values({ id: input.id, ...values, createdAt: now })
        .onConflictDoUpdate({ target: hostingDestinations.id, set: values }),
      ...declarations,
    ],
    {
      action: "destination.save",
      target: input.id,
      detail: {
        policies: policies.join(","),
        capabilities: Object.keys(verified).join(","),
        ...evidenceDetail(verified),
      },
    }
  );
};

export type CapabilityEvidence =
  typeof destinationCapabilityEvidence.$inferSelect;

/** Every capability destination `id` was declared with, in the order saved. */
export const capabilityEvidence = async (
  db: AdminDatabase,
  id: string
): Promise<CapabilityEvidence[]> =>
  await db
    .select()
    .from(destinationCapabilityEvidence)
    .where(eq(destinationCapabilityEvidence.destinationId, id))
    .orderBy(asc(destinationCapabilityEvidence.id));

export const destinationOf = async (db: AdminDatabase, id: string) => {
  const row = await db
    .select()
    .from(hostingDestinations)
    .where(eq(hostingDestinations.id, id))
    .get();
  if (row === undefined) {
    throw new InventoryError("destination_unknown", `No destination ${id}`);
  }
  return {
    ...row,
    policies: z.array(z.string()).parse(JSON.parse(row.policies)),
    capabilities: destinationCapabilitiesSchema.parse(
      JSON.parse(row.capabilities)
    ),
  };
};

/** Throws unless `destinationId` satisfies every requirement of `policyId`. */
export const assertPlaceable = async (
  db: AdminDatabase,
  destinationId: string,
  policyId: HostingPolicyId
): Promise<void> => {
  const destination = await destinationOf(db, destinationId);
  const problems = placementProblems(
    hostingPolicies[policyId],
    destination.policies,
    destination.capabilities
  );
  if (problems.length > 0) {
    throw new InventoryError(
      "placement_refused",
      `${destinationId} can't host ${policyId}: ${problems.map((problem) => ("capability" in problem ? `${problem.kind} ${problem.capability}` : problem.kind)).join(", ")}`,
      problems
    );
  }
};

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const DEPLOYMENT_ID_LENGTH = 10;

/** A new deployment id: random, lowercase, never derived from the client. */
const newDeploymentId = (): string =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(DEPLOYMENT_ID_LENGTH)),
    // 256 is a multiple of 32: no letter is likelier than another.
    (byte) => BASE32[byte % BASE32.length]
  ).join("");

export const placementOf = async (
  db: AdminDatabase,
  clientId: string
): Promise<ClientPlacement | undefined> =>
  await db
    .select()
    .from(clientPlacements)
    .where(eq(clientPlacements.clientId, clientId))
    .get();

/**
 * Places client `clientId` in destination `destinationId` under policy
 * `policyId`, once: placing it again the same way returns the placement it
 * has. Moving it, or changing its policy, isn't a placement: a storage
 * jurisdiction is set when a resource is created, so a change is
 * provision, copy, verify, cut over and retire onto new resources (spec
 * 38). This refuses it rather than relabel what's there.
 */
export const placeClient = async (
  db: AdminDatabase,
  actor: Actor,
  placement: { clientId: string; destinationId: string; policyId: string }
): Promise<ClientPlacement> => {
  const policyId = hostingPolicyIdSchema.parse(placement.policyId);
  const existing = await placementOf(db, placement.clientId);
  if (existing === undefined) {
    await assertPlaceable(db, placement.destinationId, policyId);
    // A placement made at the same time wins or loses here; both callers
    // then compare against the one that stuck.
    await actIfChanged(
      db,
      actor,
      db
        .insert(clientPlacements)
        .values({
          clientId: placement.clientId,
          deploymentId: newDeploymentId(),
          destinationId: placement.destinationId,
          policyId,
          placedBy: actor === "system" ? actor : actor.email,
          placedAt: new Date(),
        })
        .onConflictDoNothing(),
      {
        action: "client.place",
        clientId: placement.clientId,
        target: placement.destinationId,
        detail: { policy: policyId },
      }
    );
  }
  const placed = await placementOf(db, placement.clientId);
  if (placed === undefined) {
    throw new Error(`${placement.clientId} has no placement after placing it`);
  }
  if (
    placed.destinationId !== placement.destinationId ||
    placed.policyId !== policyId
  ) {
    throw new InventoryError(
      "placement_changed",
      `${placement.clientId} is placed in ${placed.destinationId} under ${placed.policyId}; moving it is a migration`
    );
  }
  return placed;
};

/** A resource a release needs of a client, before it's named. */
interface Role {
  role: string;
  kind: ResourceKind;
  /** The release's own name for it, which its physical name keeps readable. */
  logicalName: string;
  /** A Durable Object class a later migration deleted. */
  tombstoned: boolean;
}

const durableObjectRole = (worker: WorkerEntry, className: string): string =>
  `do:${worker.name}:${className}`;

const classNamesSchema = z.array(z.string()).optional();

/**
 * The Durable Object classes `worker`'s migration history ever created,
 * and whether a later one deleted each: its class registry, tombstones
 * included. A rename or a transfer moves an object's data identity to
 * another name, which needs a decision on how the inventory follows it,
 * so it stops here rather than guess.
 */
const durableObjectRoles = (worker: WorkerEntry): Role[] => {
  const classes = new Map<string, boolean>();
  for (const migration of worker.durableObjectMigrations) {
    const moved = [
      migration.renamed_classes,
      migration.transferred_classes,
    ].some((list) => Array.isArray(list) && list.length > 0);
    if (moved) {
      throw new InventoryError(
        "unsupported_durable_object_migration",
        `${worker.name}'s Durable Object migration ${migration.tag} renames or transfers a class`
      );
    }
    for (const name of [
      ...(classNamesSchema.parse(migration.new_classes) ?? []),
      ...(classNamesSchema.parse(migration.new_sqlite_classes) ?? []),
    ]) {
      classes.set(name, false);
    }
    for (const name of classNamesSchema.parse(migration.deleted_classes) ??
      []) {
      classes.set(name, true);
    }
  }
  return [...classes].map(([className, tombstoned]) => ({
    role: durableObjectRole(worker, className),
    kind: "durable_object_class",
    logicalName: className,
    tombstoned,
  }));
};

/**
 * Every private resource `manifest` needs of a client, once each: its
 * Workers' scripts, D1 databases, R2 buckets (each in `jurisdiction`, or
 * it stops) and Durable Object classes.
 */
export const resourceRoles = (
  manifest: ReleaseManifest,
  jurisdiction: Jurisdiction
): Role[] => {
  const roles = new Map<string, Role>();
  const add = (role: Role) => roles.set(role.role, role);
  for (const worker of Object.values(manifest.workers)) {
    add({
      role: `worker:${worker.name}`,
      kind: "worker_script",
      logicalName: worker.name,
      tombstoned: false,
    });
    for (const database of worker.d1Databases) {
      add({
        role: `d1:${database.databaseName}`,
        kind: "d1_database",
        logicalName: database.databaseName,
        tombstoned: false,
      });
    }
    for (const binding of worker.bindings) {
      if (binding.type !== "r2_bucket") {
        continue;
      }
      if (
        typeof binding.bucket_name !== "string" ||
        binding.jurisdiction !== jurisdiction
      ) {
        throw new InventoryError(
          "bucket_jurisdiction",
          `${worker.name} binds ${binding.name} outside ${jurisdiction}`
        );
      }
      add({
        role: `r2:${binding.bucket_name}`,
        kind: "r2_bucket",
        logicalName: binding.bucket_name,
        tombstoned: false,
      });
    }
    for (const role of durableObjectRoles(worker)) {
      add(role);
    }
  }
  return [...roles.values()];
};

/** The longest name Workers, D1 and R2 all take. */
const MAX_NAME = 63;
const HASH_LENGTH = 8;

/**
 * The name a resource has in the destination: the deployment id, then the
 * release's name for it, cut and suffixed with a hash of the whole when
 * it would be too long. Never the client's name, never a release's.
 */
export const physicalName = async (
  deploymentId: string,
  logicalName: string
): Promise<string> => {
  const name = `g${deploymentId}-${logicalName}`;
  if (name.length <= MAX_NAME) {
    return name;
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(name)
  );
  const hash = toHex(new Uint8Array(digest)).slice(0, HASH_LENGTH);
  const kept = name.slice(0, MAX_NAME - HASH_LENGTH - 1).replace(/-+$/u, "");
  return `${kept}-${hash}`;
};

const physicalNameOf = async (
  placement: ClientPlacement,
  scripts: ReadonlyMap<string, string>,
  role: Role,
  worker: string | undefined
): Promise<string> => {
  if (role.kind !== "durable_object_class") {
    return await physicalName(placement.deploymentId, role.logicalName);
  }
  // A class is named within its script: one namespace per script and class.
  const script = worker === undefined ? undefined : scripts.get(worker);
  if (script === undefined) {
    throw new Error(`${role.role} has no script`);
  }
  return `${script}:${role.logicalName}`;
};

/** The client's inventory, every role in order: what an export enumerates. */
export const clientInventory = async (
  db: AdminDatabase,
  clientId: string
): Promise<ClientResource[]> =>
  await db
    .select()
    .from(clientResources)
    .where(eq(clientResources.clientId, clientId))
    .orderBy(asc(clientResources.role))
    .all();

/** Whether recorded `row` is the resource `wanted` describes. */
const matches = (row: ClientResource, wanted: ClientResource): boolean =>
  row.kind === wanted.kind &&
  row.destinationId === wanted.destinationId &&
  row.physicalName === wanted.physicalName &&
  row.jurisdiction === wanted.jurisdiction &&
  row.owner === wanted.owner;

/**
 * Records every resource `manifest` needs of placed client `clientId`,
 * named for its deployment, before any is created: running it again, or
 * for a later release, adds only what's new and changes nothing recorded.
 * A role recorded differently stops it; a Durable Object class a release
 * deleted is kept, tombstoned. Re-checks the destination against the
 * client's policy first, so a capability withdrawn since stops it.
 */
export const allocateClientResources = async (
  db: AdminDatabase,
  actor: Actor,
  allocation: {
    clientId: string;
    manifest: ReleaseManifest;
    operationId: string;
  }
): Promise<ClientResource[]> => {
  const { clientId, manifest, operationId } = allocation;
  const placement = await placementOf(db, clientId);
  if (placement === undefined) {
    throw new InventoryError("not_placed", `${clientId} isn't placed`);
  }
  const policyId = hostingPolicyIdSchema.parse(placement.policyId);
  await assertPlaceable(db, placement.destinationId, policyId);
  const jurisdiction = hostingPolicies[policyId].storageJurisdiction;

  const scripts = new Map<string, string>();
  for (const worker of Object.values(manifest.workers)) {
    scripts.set(
      worker.name,
      // oxlint-disable-next-line no-await-in-loop -- core and connect
      await physicalName(placement.deploymentId, worker.name)
    );
  }
  const workerOf = new Map(
    Object.values(manifest.workers).flatMap((worker) =>
      durableObjectRoles(worker).map(({ role }) => [role, worker.name])
    )
  );
  const now = new Date();
  const wanted = await Promise.all(
    resourceRoles(manifest, jurisdiction).map(
      async (role): Promise<ClientResource> => ({
        clientId,
        role: role.role,
        kind: role.kind,
        destinationId: placement.destinationId,
        physicalName: await physicalNameOf(
          placement,
          scripts,
          role,
          workerOf.get(role.role)
        ),
        providerId: null,
        createRequestedBy: null,
        jurisdiction,
        owner: placement.deploymentId,
        operationId,
        lifecycle: role.tombstoned ? "tombstoned" : "allocated",
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      })
    )
  );

  const before = await clientInventory(db, clientId);
  const recorded = new Map(before.map((row) => [row.role, row]));
  const added: ClientResource[] = [];
  const tombstoned: ClientResource[] = [];
  for (const resource of wanted) {
    const row = recorded.get(resource.role);
    if (row === undefined) {
      added.push(resource);
      continue;
    }
    // A class comes back only as a new class, with no data: a decision,
    // not something to bind to the old identity.
    const revived =
      row.lifecycle === "tombstoned" && resource.lifecycle === "allocated";
    if (!matches(row, resource) || revived) {
      throw new InventoryError(
        "resource_conflict",
        `${clientId}'s ${resource.role} is recorded as ${row.kind} ${row.physicalName} (${row.lifecycle})`
      );
    }
    if (row.lifecycle === "allocated" && resource.lifecycle === "tombstoned") {
      tombstoned.push(resource);
    }
  }
  const [first, ...rest] = [
    ...added.map((resource) =>
      db.insert(clientResources).values(resource).onConflictDoNothing()
    ),
    ...tombstoned.map((resource) =>
      db
        .update(clientResources)
        .set({ lifecycle: "tombstoned", updatedAt: now })
        .where(
          and(
            eq(clientResources.clientId, clientId),
            eq(clientResources.role, resource.role)
          )
        )
    ),
  ];
  if (first !== undefined) {
    await act(db, actor, [first, ...rest], {
      action: "client.resources_allocate",
      clientId,
      target: operationId,
      detail: { added: added.length, tombstoned: tombstoned.length },
    });
  }

  // What the database holds now, checked again: an allocation running at
  // the same time may have recorded a role first.
  const inventory = await clientInventory(db, clientId);
  const byRole = new Map(inventory.map((row) => [row.role, row]));
  for (const resource of wanted) {
    const row = byRole.get(resource.role);
    if (row === undefined || !matches(row, resource)) {
      throw new InventoryError(
        "resource_conflict",
        `${clientId}'s ${resource.role} changed while it was allocated`
      );
    }
  }
  return inventory;
};

/**
 * Records the provider's id for a resource it observed by its recorded
 * physical name, once: the id never changes after. A resource observed
 * under another id is someone else's, or recreated, and stops it. With
 * `held`, only while that runner still holds the client: a runner that
 * lost it records nothing.
 */
export const recordProviderId = async (
  db: AdminDatabase,
  actor: Actor,
  observed: {
    clientId: string;
    role: string;
    physicalName: string;
    providerId: string;
  },
  held?: HeldClient
): Promise<void> => {
  const { clientId, role, providerId } = observed;
  const where = and(
    eq(clientResources.clientId, clientId),
    eq(clientResources.role, role),
    eq(clientResources.physicalName, observed.physicalName),
    or(
      isNull(clientResources.providerId),
      eq(clientResources.providerId, providerId)
    )
  );
  await actIfChanged(
    db,
    actor,
    db
      .update(clientResources)
      .set({ providerId, updatedAt: new Date() })
      .where(
        and(
          where,
          isNull(clientResources.providerId),
          held === undefined ? undefined : stillHolds(held)
        )
      ),
    { action: "client.resource_observe", clientId, target: role }
  );
  const row = await db.select().from(clientResources).where(where).get();
  if (row?.providerId === providerId) {
    return;
  }
  if (
    held !== undefined &&
    !(await holdsClient(
      db,
      held.clientId,
      held.runId,
      held.attempt,
      held.attemptKey
    ))
  ) {
    throw new InventoryError(
      "runner_replaced",
      `${held.runId} no longer holds ${clientId}`
    );
  }
  throw new InventoryError(
    "resource_conflict",
    `${clientId}'s ${role} isn't ${observed.physicalName} with id ${providerId}`
  );
};

/** Binding kinds that name no resource of the client's: nothing to map. */
const unmappedBindings = new Set([
  "ai",
  "assets",
  "send_email",
  "version_metadata",
  "worker_loader",
]);

/**
 * What core and connect read to take their Durable Objects out of the
 * EU-restricted namespace (`none`, for workerd and on-prem: core's
 * src/durable-objects.ts, connect's src/clock.ts). Unset is the EU, which
 * a placed client's policy requires, so no binding of a placed client's
 * Worker carries the name, whatever its kind or value.
 */
const durableObjectJurisdiction = "DURABLE_OBJECT_JURISDICTION";

/** How a destination takes a Worker's bindings. */
export interface RenderOptions {
  /**
   * A Workers for Platforms namespace: a user Worker can't bind another
   * by a service binding (10143, GRA-430), so each service binding binds
   * the connect gateway instead, its props naming the client's own script
   * (@grasp-os/shared/connect-gateway, GRA-1217): this one, the gateway of
   * the namespace's stage (@grasp-os/shared/names). Unset elsewhere.
   */
  connectGateway?: string;
}

/** One of `worker`'s Workers as the destination takes it. */
export interface RenderedWorker {
  scriptName: string;
  bindings: Record<string, unknown>[];
}

/**
 * `worker`'s bindings mapped onto client `placement`'s `inventory`: each
 * D1 binding to its database's observed id, each R2 binding to its
 * bucket in the jurisdiction the inventory records, each service to the
 * client's own script and each Durable Object binding to a live class of
 * the Worker's own script. A resource that isn't the placement's own (another
 * client's, deployment's or destination's), isn't recorded, or is
 * tombstoned stops it, as does any binding kind it doesn't map, any
 * placeholder left and any binding named for the Durable Object
 * jurisdiction: before anything is uploaded.
 */
export const renderClientWorker = (
  worker: WorkerEntry,
  placement: ClientPlacement,
  inventory: readonly ClientResource[],
  { connectGateway }: RenderOptions = {}
): RenderedWorker => {
  const byRole = new Map(inventory.map((row) => [row.role, row]));
  const resource = (
    binding: string,
    role: string,
    kind: ResourceKind
  ): ClientResource => {
    const row = byRole.get(role);
    if (row === undefined || row.kind !== kind) {
      throw new InventoryError(
        "resource_missing",
        `${worker.name}'s ${binding} needs ${role}, which isn't recorded`
      );
    }
    const own =
      row.clientId === placement.clientId &&
      row.owner === placement.deploymentId &&
      row.destinationId === placement.destinationId;
    if (!own) {
      throw new InventoryError(
        "foreign_resource",
        `${worker.name}'s ${binding} would bind ${row.physicalName}, which isn't ${placement.clientId}'s`
      );
    }
    if (row.lifecycle !== "allocated") {
      throw new InventoryError(
        "resource_missing",
        `${worker.name}'s ${binding} needs ${role}, which is ${row.lifecycle}`
      );
    }
    return row;
  };

  const bindings = worker.bindings.map((binding) => {
    if (binding.name === durableObjectJurisdiction) {
      throw new InventoryError(
        "durable_object_jurisdiction",
        `${worker.name}'s ${binding.name} would set its Durable Objects' jurisdiction`
      );
    }
    const rendered: Record<string, unknown> = { ...binding };
    switch (binding.type) {
      case "d1": {
        const database = worker.d1Databases.find(
          (entry) => entry.binding === binding.name
        );
        if (
          database === undefined ||
          binding.id !== d1IdPlaceholder(binding.name)
        ) {
          throw new InventoryError(
            "unknown_placeholder",
            `${worker.name}'s ${binding.name} names a placeholder rendering doesn't fill`
          );
        }
        const row = resource(
          binding.name,
          `d1:${database.databaseName}`,
          "d1_database"
        );
        if (row.providerId === null) {
          throw new InventoryError(
            "resource_missing",
            `${worker.name}'s ${binding.name} needs ${row.physicalName}, which isn't observed yet`
          );
        }
        rendered.id = row.providerId;
        break;
      }
      case "r2_bucket": {
        const row = resource(
          binding.name,
          `r2:${String(binding.bucket_name)}`,
          "r2_bucket"
        );
        if (binding.jurisdiction !== row.jurisdiction) {
          throw new InventoryError(
            "bucket_jurisdiction",
            `${worker.name}'s ${binding.name} is outside ${row.jurisdiction}`
          );
        }
        rendered.bucket_name = row.physicalName;
        break;
      }
      case "service": {
        const script = resource(
          binding.name,
          `worker:${String(binding.service)}`,
          "worker_script"
        ).physicalName;
        if (connectGateway === undefined) {
          rendered.service = script;
          break;
        }
        // The gateway forwards to the default entrypoint alone.
        if (binding.entrypoint !== undefined) {
          throw new InventoryError(
            "unsupported_binding",
            `${worker.name}'s ${binding.name} names an entrypoint, which the connect gateway doesn't forward to`
          );
        }
        // Only what the binding is, its target and props: nothing else of
        // the release's entry reaches the gateway.
        return {
          type: "service",
          name: binding.name,
          service: connectGateway,
          props: { script } satisfies ConnectGatewayProps,
        };
      }
      case "durable_object_namespace": {
        // Another script's class would reach past this Worker's own objects.
        if (binding.script_name !== undefined) {
          throw new InventoryError(
            "unsupported_binding",
            `${worker.name}'s ${binding.name} binds another script's objects`
          );
        }
        resource(
          binding.name,
          durableObjectRole(worker, String(binding.class_name)),
          "durable_object_class"
        );
        break;
      }
      default: {
        if (!unmappedBindings.has(binding.type)) {
          throw new InventoryError(
            "unsupported_binding",
            `${worker.name}'s ${binding.name} is a ${binding.type} binding, which rendering doesn't map`
          );
        }
      }
    }
    for (const value of Object.values(rendered)) {
      if (typeof value === "string" && value.startsWith("$")) {
        throw new InventoryError(
          "unknown_placeholder",
          `${worker.name}'s ${binding.name} names a placeholder rendering doesn't fill`
        );
      }
    }
    return rendered;
  });
  return {
    scriptName: resource("script", `worker:${worker.name}`, "worker_script")
      .physicalName,
    bindings,
  };
};
