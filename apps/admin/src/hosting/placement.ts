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
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import { clients, hostingDestinations } from "../db/schema.ts";
import { importedManifest } from "../deploy/release.ts";
import { ProvisionError } from "../provision/errors.ts";
import { currentRun, hasEnded } from "../runners.ts";
import type { RunStatus } from "../runners.ts";
import { InventoryError, placeClient, placementOf } from "./inventory.ts";
import type { InventoryErrorCode } from "./inventory.ts";
import { ProvisionOperationError, provisionOf } from "./operation.ts";
import type { ProvisionOperationErrorCode } from "./operation.ts";
import {
  destinationCapabilitiesSchema,
  hostingPolicies,
  hostingPolicyIdSchema,
  placementProblems,
} from "./policy.ts";
import type { HostingPolicyId, PlacementProblem } from "./policy.ts";
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

/** A destination as staff choose among them. */
export interface DestinationChoice {
  id: string;
  kind: DestinationKind;
  /** Shared by several clients (Workers for Platforms): what allocation picks from. */
  shared: boolean;
  /** Empty when it can take the client. */
  problems: DestinationProblem[];
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
      const problems: DestinationProblem[] = placementProblems(
        hostingPolicies[policyId],
        z.array(z.string()).parse(JSON.parse(row.policies)),
        destinationCapabilitiesSchema.parse(JSON.parse(row.capabilities))
      );
      if (!provisionable(row)) {
        problems.push({ kind: "not_provisionable" });
      }
      return {
        id: row.id,
        kind: row.kind,
        shared: row.kind === "workers_for_platforms",
        problems,
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
    .select({ id: clients.id, status: clients.status })
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();
  if (client === undefined) {
    return null;
  }
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
