/**
 * Choosing where a client runs, and starting its provisioning there (spec
 * 37.3, 38, 40.1): every hosting destination with what keeps it from
 * taking the client under a policy, the one the admin picks by itself
 * when there's a clear choice, and placing the client and starting (or
 * resuming) its one operation, as a staff member.
 *
 * Destination allocation is automatic: the client goes in the shared
 * destination (Workers for Platforms) that meets every requirement of its
 * policy. Dedicated hosting is never picked by itself, nor fallen back to
 * when no shared destination qualifies: it's an explicit choice staff
 * make, as is any destination when there's no clear one.
 */
import {
  clientsNamespace,
  platformAccountId,
  stageNamed,
} from "@grasp-os/shared/names";
import type { Stage } from "@grasp-os/shared/names";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { actIfChanged, adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import { clients, hostingDestinations } from "../db/schema.ts";
import { importedManifest } from "../deploy/release.ts";
import { ProvisionError } from "../provision/errors.ts";
import { currentRun, hasEnded } from "../runners.ts";
import type { RunStatus } from "../runners.ts";
import {
  checksItself,
  InventoryError,
  placeClient,
  placementOf,
} from "./inventory.ts";
import type { InventoryErrorCode } from "./inventory.ts";
import { ProvisionOperationError, provisionOf } from "./operation.ts";
import type { ProvisionOperationErrorCode } from "./operation.ts";
import {
  destinationCapabilitiesSchema,
  hostingPolicies,
  hostingPolicyIdSchema,
  placementProblems,
  selfCheckedCapabilities,
} from "./policy.ts";
import type {
  Capability,
  DestinationCapabilities,
  HostingPolicyId,
  PlacementProblem,
} from "./policy.ts";
import { provisionPlacedClient } from "./workflow.ts";

type DestinationKind = (typeof hostingDestinations.kind.enumValues)[number];

/**
 * What keeps a destination from taking a client: a requirement of the
 * policy it doesn't meet, or (`not_provisionable`) it isn't somewhere the
 * admin creates resources: a workerd destination, set up by its
 * operator, or one without the account or namespace a provisioning
 * operation needs (`load`, src/hosting/operation.ts).
 */
export type DestinationProblem =
  | PlacementProblem
  | { kind: "not_provisionable" };

/**
 * Where one requirement of a policy stands in a destination: checked and
 * found so, or not; still to be checked by a person; or to be checked by
 * provisioning itself, the first time it runs there.
 */
export interface CapabilityCheck {
  capability: Capability;
  state: "verified" | "unsupported" | "needs_checking" | "checked_on_provision";
  /** Who observed it (a staff member's email, or `system`), when, how and where it is recorded; null until someone has. */
  evidence: {
    recordedBy: string;
    observedAt: string;
    procedure: string;
    record: string;
  } | null;
}

/** Every requirement of `policyId` in a destination of `kind` with `capabilities`, as a checklist. */
export const capabilityChecks = (
  policyId: HostingPolicyId,
  kind: DestinationKind,
  capabilities: DestinationCapabilities
): CapabilityCheck[] =>
  hostingPolicies[policyId].requires.map((capability) => {
    const entry = capabilities[capability];
    if (entry === undefined) {
      return {
        capability,
        state:
          checksItself(kind) && selfCheckedCapabilities.includes(capability)
            ? "checked_on_provision"
            : "needs_checking",
        evidence: null,
      };
    }
    const { recordedBy, observedAt, procedure, record } = entry.evidence;
    return {
      capability,
      state: entry.status,
      evidence: { recordedBy, observedAt, procedure, record },
    };
  });

/** A destination as staff choose among them. */
export interface DestinationChoice {
  id: string;
  kind: DestinationKind;
  /** Shared by several clients (Workers for Platforms): what allocation picks from. */
  shared: boolean;
  /** Empty when it can take the client. */
  problems: DestinationProblem[];
  /** Each requirement of the policy, and where it stands. */
  checks: CapabilityCheck[];
}

/**
 * The destination the admin picks by itself, or why there's none:
 * `none` when no shared destination meets every requirement, `several`
 * when more than one does.
 */
export type AutomaticChoice =
  | { destinationId: string; reason: null }
  | { destinationId: null; reason: "none" | "several" };

/** A client's hosting, as its page shows it. */
export interface ClientHostingView {
  clientId: string;
  policy: { id: HostingPolicyId; description: string };
  placement: {
    destinationId: string;
    policyId: string;
    placedBy: string;
    placedAt: Date;
  } | null;
  /** Shared ones first, then dedicated, then the rest, each by id. */
  destinations: DestinationChoice[];
  automatic: AutomaticChoice;
  /** Whether it's live: its later releases and rollbacks run the operation again. */
  active: boolean;
  /** When staff offboarded it; null while they haven't (src/hosting/offboarding.ts). */
  offboardedAt: Date | null;
  /** Its provisioning operation (`client_provisions`), if it has one. */
  operation: {
    releaseId: string;
    /** What it ran before its latest release or rollback started; null before its first. */
    previousReleaseId: string | null;
    status: "running" | "failed" | "done";
    /** The last step that finished; null before the first. */
    step: string | null;
    /** The code it stopped with. */
    error: string | null;
    startedBy: string;
    updatedAt: Date;
  } | null;
  /** Its current attempt's status, when its runner is a provisioning attempt. */
  run: RunStatus | null;
  /** Whether that attempt is still going, so the page follows it. */
  going: boolean;
}

const kindOrder: Readonly<Record<DestinationKind, number>> = {
  workers_for_platforms: 0,
  dedicated: 1,
  workerd: 2,
};

/** Whether the admin can run a provisioning operation in a destination like `row`. */
const provisionable = (row: {
  kind: DestinationKind;
  accountId: string | null;
  namespace: string | null;
}): boolean =>
  row.accountId !== null &&
  (row.kind === "dedicated" ||
    (row.kind === "workers_for_platforms" && row.namespace !== null));

/** The id of `stage`'s own shared destination, as its admin records it. */
export const stageDestinationId = (stage: Stage): string =>
  `workers-for-platforms-${stage}`;

/**
 * Records this admin's own stage's shared destination when it has none:
 * Grasp's account and the stage's clients' namespace (@grasp-os/shared/names),
 * the place every client of the stage goes. Nothing else ever records it,
 * so without this a new admin has nowhere to put anyone.
 *
 * Here, ahead of every read of the destinations that placing a client
 * depends on (the hosting view and placing itself), rather than at a
 * deploy or a start: a Worker has no start to hook, a deploy can't write
 * the admin's database through its audit log, and this path is the one
 * no placement can skip. It runs once: a destination in that namespace,
 * recorded here or by staff, is left as it is.
 *
 * It claims no capability: each is unknown until staff record evidence
 * of it, as a policy requires (src/hosting/policy.ts), so nothing is
 * placed here on the admin's word. An admin whose STAGE names no stage
 * records nothing, and the namespace is the stage's own, so a staging
 * admin never records production's.
 */
export const ensureStageDestination = async (
  env: Env,
  db: AdminDatabase
): Promise<void> => {
  const stage = stageNamed(env.STAGE);
  if (stage === undefined) {
    return;
  }
  const namespace = clientsNamespace(stage);
  const id = stageDestinationId(stage);
  const now = Date.now();
  // Insert only, in one statement: while no destination is in the
  // namespace, and never over one with its id. Two reads at once create
  // it once, audited once; nothing already there is ever overwritten.
  await actIfChanged(
    db,
    "system",
    db
      .insert(hostingDestinations)
      .select(
        sql`SELECT ${id}, ${"workers_for_platforms"}, ${platformAccountId}, ${namespace}, ${JSON.stringify(["eu-storage"])}, ${"{}"}, ${now}, ${now} WHERE NOT EXISTS (SELECT 1 FROM ${hostingDestinations} WHERE ${hostingDestinations.namespace} = ${namespace})`
      )
      .onConflictDoNothing(),
    {
      action: "destination.create",
      target: id,
      detail: { namespace, policies: "eu-storage" },
    }
  );
};

/** Every destination, and what keeps each from taking a client under `policyId`. */
export const destinationChoices = async (
  db: AdminDatabase,
  policyId: HostingPolicyId
): Promise<DestinationChoice[]> => {
  const rows = await db
    .select()
    .from(hostingDestinations)
    .orderBy(asc(hostingDestinations.id))
    .all();
  return rows
    .map((row) => {
      const capabilities = destinationCapabilitiesSchema.parse(
        JSON.parse(row.capabilities)
      );
      const problems: DestinationProblem[] = placementProblems(
        hostingPolicies[policyId],
        z.array(z.string()).parse(JSON.parse(row.policies)),
        capabilities,
        checksItself(row.kind)
      );
      if (!provisionable(row)) {
        problems.push({ kind: "not_provisionable" });
      }
      return {
        id: row.id,
        kind: row.kind,
        shared: row.kind === "workers_for_platforms",
        problems,
        checks: capabilityChecks(policyId, row.kind, capabilities),
      };
    })
    .toSorted((a, b) => kindOrder[a.kind] - kindOrder[b.kind]);
};

/** A destination as Platform's Destinations page shows it. */
export interface DestinationOverview {
  id: string;
  kind: DestinationKind;
  accountId: string | null;
  namespace: string | null;
  /** The policies it serves. */
  policies: string[];
  /** For each policy there is, what keeps it out, and each requirement's check. */
  byPolicy: {
    policyId: HostingPolicyId;
    description: string;
    problems: DestinationProblem[];
    checks: CapabilityCheck[];
  }[];
}

/**
 * Every destination, with where each stands under every policy, for
 * Platform's Destinations page: this admin's own recorded first, so a
 * new admin's page shows it before any client is added.
 */
export const destinationsOverview = async (
  env: Env
): Promise<DestinationOverview[]> => {
  const db = adminDatabase(env.DB);
  await ensureStageDestination(env, db);
  const rows = await db
    .select()
    .from(hostingDestinations)
    .orderBy(asc(hostingDestinations.id))
    .all();
  const policyIds = hostingPolicyIdSchema.options;
  return rows
    .map((row) => {
      const capabilities = destinationCapabilitiesSchema.parse(
        JSON.parse(row.capabilities)
      );
      const policies = z.array(z.string()).parse(JSON.parse(row.policies));
      return {
        id: row.id,
        kind: row.kind,
        accountId: row.accountId,
        namespace: row.namespace,
        policies,
        byPolicy: policyIds.map((policyId) => {
          const problems: DestinationProblem[] = placementProblems(
            hostingPolicies[policyId],
            policies,
            capabilities,
            checksItself(row.kind)
          );
          if (!provisionable(row)) {
            problems.push({ kind: "not_provisionable" });
          }
          return {
            policyId,
            description: hostingPolicies[policyId].description,
            problems,
            checks: capabilityChecks(policyId, row.kind, capabilities),
          };
        }),
      };
    })
    .toSorted((a, b) => kindOrder[a.kind] - kindOrder[b.kind]);
};

/**
 * The destination the admin picks by itself from `choices`: the shared
 * one that meets every requirement, when exactly one does. Conservative
 * on purpose, since a placement is for good (moving a client is a
 * migration, spec 38): spec 37.2 keeps one shared namespace per
 * environment and policy, so two that qualify mean staff recorded more
 * than one place a client could go, and which one is theirs to say, not
 * the admin's to guess. With none, nothing is picked either: dedicated
 * hosting is an explicit choice, never a fallback.
 */
export const automaticChoice = (
  choices: readonly DestinationChoice[]
): AutomaticChoice => {
  const placeable = choices.filter(
    (choice) => choice.shared && choice.problems.length === 0
  );
  const [only, ...others] = placeable;
  if (only === undefined) {
    return { destinationId: null, reason: "none" };
  }
  if (others.length > 0) {
    return { destinationId: null, reason: "several" };
  }
  return { destinationId: only.id, reason: null };
};

/** Client `clientId`'s hosting under `policyId`, or null when there's no such client. */
export const getClientHosting = async (
  env: Env,
  clientId: string,
  policyId: HostingPolicyId
): Promise<ClientHostingView | null> => {
  const db = adminDatabase(env.DB);
  const client = await db
    .select({
      id: clients.id,
      status: clients.status,
      offboardedAt: clients.offboardedAt,
    })
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();
  if (client === undefined) {
    return null;
  }
  await ensureStageDestination(env, db);
  const placement = await placementOf(db, clientId);
  // A placed client stays under its own policy: the one shown is that.
  const policy =
    hostingPolicies[
      hostingPolicyIdSchema.parse(placement?.policyId ?? policyId)
    ];
  const destinations = await destinationChoices(db, policy.id);
  const operation = await provisionOf(db, clientId);
  const current = await currentRun(env, clientId);
  const attempt = current?.kind === "provision_placed" ? current.status : null;
  return {
    clientId,
    policy: { id: policy.id, description: policy.description },
    placement:
      placement === undefined
        ? null
        : {
            destinationId: placement.destinationId,
            policyId: placement.policyId,
            placedBy: placement.placedBy,
            placedAt: placement.placedAt,
          },
    destinations,
    automatic:
      placement === undefined
        ? automaticChoice(destinations)
        : { destinationId: placement.destinationId, reason: null },
    active: client.status === "active",
    offboardedAt: client.offboardedAt,
    operation:
      operation === undefined
        ? null
        : {
            releaseId: operation.releaseId,
            previousReleaseId: operation.previousReleaseId,
            status: operation.status,
            step: operation.step,
            error: operation.error,
            startedBy: operation.startedBy,
            updatedAt: operation.updatedAt,
          },
    run: attempt,
    going: attempt !== null && !hasEnded(attempt),
  };
};

export const placementErrorCodes = [
  /** No destination was chosen, and there's no clear one to pick (`automaticChoice`). */
  "no_automatic_destination",
  /**
   * The client's last run was another kind's (provisioning in an account of
   * its own): placing it would take that run's claim, so it could never resume.
   */
  "other_run_held",
] as const;

export type PlacementErrorCode = (typeof placementErrorCodes)[number];

export class PlacementError extends Error {
  readonly code: PlacementErrorCode;

  constructor(code: PlacementErrorCode, message: string) {
    super(message);
    this.name = "PlacementError";
    this.code = code;
  }
}

/** Why placing and provisioning a client was refused: a fixed code staff act on. */
export type PlaceRefusal =
  | PlacementErrorCode
  | InventoryErrorCode
  | ProvisionOperationErrorCode
  | Extract<ProvisionError["code"], "already_running" | "not_provisioning">;

/** What staff ask: provision `clientId` with `releaseId` under `policyId`, in `destinationId` or the automatic one (null). */
export const placeInputSchema = z.object({
  clientId: z.string().min(1),
  releaseId: z.string().min(1),
  policyId: hostingPolicyIdSchema,
  destinationId: z.string().min(1).nullable(),
});

export type PlaceInput = z.infer<typeof placeInputSchema>;

/**
 * Places client `input.clientId` under its policy, as `staff`, unless it's
 * placed already, and starts provisioning it with `input.releaseId`, or
 * resumes the operation it has (`provisionPlacedClient`). Without a
 * destination, the automatic one (`automaticChoice`); a placed client
 * stays where it is, and a destination or policy other than its own is
 * refused (`placement_changed`). Everything is checked before the client
 * is placed, since a placement is for good: that the client is still
 * being provisioned and isn't being worked on, that the release is
 * imported, and that the destination meets every requirement of the
 * policy and is one the admin provisions in. Returns the attempt's id.
 */
export const placeAndProvision = async (
  env: Env,
  staff: Staff,
  input: PlaceInput
): Promise<string> => {
  const db = adminDatabase(env.DB);
  const { clientId, releaseId, policyId } = input;
  const client = await db
    .select({ status: clients.status })
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();
  if (client === undefined) {
    throw new ProvisionOperationError(
      "client_unknown",
      `No client ${clientId}`
    );
  }
  if (client.status !== "provisioning") {
    throw new ProvisionError(
      "not_provisioning",
      `Client ${clientId} is ${client.status}`
    );
  }
  const run = await currentRun(env, clientId);
  if (run !== null && !hasEnded(run.status)) {
    throw new ProvisionError(
      "already_running",
      `Client ${clientId} is being worked on already`
    );
  }
  // An ended run of placed provisioning is this path's own, for a retry to
  // take over; any other kind's is left for its own path to resume.
  if (run !== null && run.kind !== "provision_placed") {
    throw new PlacementError(
      "other_run_held",
      `Client ${clientId}'s last run, ${run.runId}, is a ${run.kind} run`
    );
  }
  if ((await importedManifest(db, releaseId)) === null) {
    throw new ProvisionOperationError(
      "release_not_imported",
      `Release ${releaseId} isn't imported`
    );
  }
  const placed = await placementOf(db, clientId);
  if (placed === undefined) {
    await ensureStageDestination(env, db);
    const choices = await destinationChoices(db, policyId);
    const destinationId =
      input.destinationId ?? automaticChoice(choices).destinationId;
    if (destinationId === null) {
      throw new PlacementError(
        "no_automatic_destination",
        `No one shared destination meets every requirement of ${policyId}`
      );
    }
    const chosen = choices.find(({ id }) => id === destinationId);
    if (chosen === undefined) {
      throw new InventoryError(
        "destination_unknown",
        `No destination ${destinationId}`
      );
    }
    if (chosen.problems.some(({ kind }) => kind === "not_provisionable")) {
      throw new InventoryError(
        "destination_unsupported",
        `${destinationId} isn't a Cloudflare destination the admin provisions in`
      );
    }
    // Refuses one that misses a requirement, with each it misses.
    await placeClient(db, staff, { clientId, destinationId, policyId });
  } else {
    // Placed already: where it is, and under its policy, is no change;
    // anything else is refused.
    await placeClient(db, staff, {
      clientId,
      destinationId: input.destinationId ?? placed.destinationId,
      policyId,
    });
  }
  return await provisionPlacedClient(env, staff, clientId, releaseId);
};
