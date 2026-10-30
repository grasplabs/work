/**
 * Choosing where a client runs, and starting its provisioning there (spec
 * 37.3, 40.1): every hosting destination, the one the admin picks by
 * itself, and placing the client and starting (or resuming) its one
 * operation.
 *
 * Destination allocation is automatic: a Grasp Cloud organization goes in
 * this admin's own shared destination (Workers for Platforms). Dedicated
 * hosting is never picked by itself: it stays a capability underneath,
 * unused by the admin's pages. An on-prem organization is placed nowhere:
 * its install sets itself up (GRA-1291).
 */
import {
  clientsNamespace,
  platformAccountId,
  stageNamed,
} from "@grasp-os/shared/names";
import type { Stage } from "@grasp-os/shared/names";
import { asc, count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { actIfChanged, adminDatabase } from "../db/act.ts";
import type { Actor, AdminDatabase } from "../db/act.ts";
import {
  clientPlacements,
  clients,
  hostingDestinations,
  releases,
} from "../db/schema.ts";
import { importedManifest } from "../deploy/release.ts";
import { ProvisionError } from "../provision/errors.ts";
import { currentRun, hasEnded } from "../runners.ts";
import type { RunStatus } from "../runners.ts";
import { InventoryError, placeClient, placementOf } from "./inventory.ts";
import type { InventoryErrorCode } from "./inventory.ts";
import {
  newestFittingRelease,
  ProvisionOperationError,
  provisionOf,
} from "./operation.ts";
import type { ProvisionOperationErrorCode } from "./operation.ts";
import { clientHostingOf } from "./organization.ts";
import type { OrganizationHosting } from "./organization.ts";
import { provisionPlacedClient } from "./workflow.ts";

type DestinationKind = (typeof hostingDestinations.kind.enumValues)[number];

/**
 * What keeps a destination from taking a client (`not_provisionable`): it
 * isn't somewhere the admin creates resources: a workerd destination, set
 * up by its operator, or one without the account or namespace a
 * provisioning operation needs (`load`, src/hosting/operation.ts).
 */
export interface DestinationProblem {
  kind: "not_provisionable";
}

/** A destination as staff choose among them. */
export interface DestinationChoice {
  id: string;
  kind: DestinationKind;
  /** Shared by several clients (Workers for Platforms): what allocation picks from. */
  shared: boolean;
  /** Empty when it can take the client. */
  problems: DestinationProblem[];
  /** How many clients are placed in it. */
  clients: number;
  createdAt: Date;
}

/**
 * The destination the admin picks by itself, or why there's none:
 * `none` when no shared destination can take it.
 */
export type AutomaticChoice =
  | { destinationId: string; reason: null }
  | { destinationId: null; reason: "none" };

/** A client's hosting, as its page shows it. */
export interface ClientHostingView {
  clientId: string;
  /** Where it runs, fixed once provisioned (src/hosting/organization.ts). */
  hosting: OrganizationHosting;
  placement: {
    destinationId: string;
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
  /**
   * The newest imported release it may be provisioned with
   * (`newestFittingRelease`): what starting or resuming offers first;
   * null when none fits.
   */
  suggestedReleaseId: string | null;
  /**
   * Why its provisioning hasn't started, while it has no operation: no
   * shared destination to place it in by itself, or no release it may be
   * provisioned with. Null once it has one, or when nothing keeps it.
   */
  notStarted: NotStarted | null;
  /**
   * Its current attempt's status, when its runner is a provisioning
   * attempt; `gone` when its operation runs with no runner at all, as
   * Setup reads it (src/provision/queries.ts). Null under another kind of
   * runner, or with nothing running.
   */
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
 * An admin whose STAGE names no stage
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
        sql`SELECT ${id}, ${"workers_for_platforms"}, ${platformAccountId}, ${namespace}, ${now}, ${now} WHERE NOT EXISTS (SELECT 1 FROM ${hostingDestinations} WHERE ${hostingDestinations.namespace} = ${namespace})`
      )
      .onConflictDoNothing(),
    {
      action: "destination.create",
      target: id,
      detail: { namespace },
    }
  );
};

/** Every destination, and what keeps each from taking a client. */
export const destinationChoices = async (
  db: AdminDatabase
): Promise<DestinationChoice[]> => {
  const rows = await db
    .select()
    .from(hostingDestinations)
    .orderBy(asc(hostingDestinations.id))
    .all();
  const placed = await db
    .select({
      destinationId: clientPlacements.destinationId,
      placedClients: count(),
    })
    .from(clientPlacements)
    .groupBy(clientPlacements.destinationId);
  const clientsIn = new Map(
    placed.map(({ destinationId, placedClients }) => [
      destinationId,
      placedClients,
    ])
  );
  return rows
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      shared: row.kind === "workers_for_platforms",
      problems: provisionable(row)
        ? []
        : [{ kind: "not_provisionable" as const }],
      clients: clientsIn.get(row.id) ?? 0,
      createdAt: row.createdAt,
    }))
    .toSorted((a, b) => kindOrder[a.kind] - kindOrder[b.kind]);
};

/**
 * The destination the admin picks by itself from `choices`: of the
 * shared ones it provisions in, the one with the fewest clients, the
 * oldest on a tie, then by id, so the pick is the same however often it
 * is asked and never left to staff. With none, nothing is picked:
 * dedicated hosting is never a fallback.
 */
export const automaticChoice = (
  choices: readonly DestinationChoice[]
): AutomaticChoice => {
  const [picked] = choices
    .filter((choice) => choice.shared && choice.problems.length === 0)
    .toSorted(
      (a, b) =>
        a.clients - b.clients ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id)
    );
  return picked === undefined
    ? { destinationId: null, reason: "none" }
    : { destinationId: picked.id, reason: null };
};

/**
 * Its attempt's status as the page shows it (`ClientHostingView["run"]`):
 * a provisioning attempt's own, `gone` for an operation running with no
 * runner, else null.
 */
const attemptOf = (
  current: Awaited<ReturnType<typeof currentRun>>,
  operation: string | undefined
): RunStatus | null => {
  if (current === null) {
    return operation === "running" ? "gone" : null;
  }
  return current.kind === "provision_placed" ? current.status : null;
};

/**
 * Why a client's provisioning hasn't started by itself: it runs on its
 * own premises, which Grasp's cloud doesn't provision (`on_prem`); no
 * shared destination for the admin to pick (`no_destination`); or no
 * imported release fits it (`no_release`).
 */
export type NotStarted = "on_prem" | "no_destination" | "no_release";

/** What keeps client `clientId`'s provisioning from starting, given what it would start with. */
export const notStartedOf = (
  hosting: OrganizationHosting,
  automatic: AutomaticChoice,
  suggestedReleaseId: string | null
): NotStarted | null => {
  if (hosting.hosting !== "grasp_cloud") {
    return "on_prem";
  }
  if (automatic.destinationId === null) {
    return "no_destination";
  }
  return suggestedReleaseId === null ? "no_release" : null;
};

/** Client `clientId`'s hosting, or null when there's no such client. */
export const getClientHosting = async (
  env: Env,
  clientId: string
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
  const hosting = await clientHostingOf(db, clientId);
  const destinations = await destinationChoices(db);
  const operation = await provisionOf(db, clientId);
  const current = await currentRun(env, clientId);
  const attempt = attemptOf(current, operation?.status);
  const automatic =
    placement === undefined
      ? automaticChoice(destinations)
      : { destinationId: placement.destinationId, reason: null };
  const suggestedReleaseId =
    client.status === "provisioning" && hosting.hosting === "grasp_cloud"
      ? await newestFittingRelease(db, clientId)
      : null;
  return {
    clientId,
    hosting,
    placement:
      placement === undefined
        ? null
        : {
            destinationId: placement.destinationId,
            placedBy: placement.placedBy,
            placedAt: placement.placedAt,
          },
    destinations,
    automatic,
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
    suggestedReleaseId,
    notStarted:
      operation === undefined && client.status === "provisioning"
        ? notStartedOf(hosting, automatic, suggestedReleaseId)
        : null,
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
  /** No release was chosen, and no imported release fits the client (`newestFittingRelease`). */
  "no_fitting_release",
  /** It runs on its own premises: Grasp's cloud provisions nothing for it. */
  "hosted_on_prem",
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

/**
 * What staff ask: provision `clientId` with `releaseId` (null: the newest
 * that fits it), in `destinationId` or the automatic one (null).
 */
export const placeInputSchema = z.object({
  clientId: z.string().min(1),
  releaseId: z.string().min(1).nullable(),
  destinationId: z.string().min(1).nullable(),
});

export type PlaceInput = z.infer<typeof placeInputSchema>;

/**
 * The release a provisioning started or tried again without one picked
 * runs with: the newest imported release that fits the client
 * (`newestFittingRelease`, every release looked through). For one with an
 * operation, the newest that fits among those built after its recorded
 * release, so a fix released since moves it forward; with none newer
 * that fits, its recorded release, so it is never left without one.
 */
const resumeRelease = async (
  db: AdminDatabase,
  clientId: string
): Promise<string | null> => {
  const operation = await provisionOf(db, clientId);
  if (operation === undefined) {
    return await newestFittingRelease(db, clientId);
  }
  const recorded = await db
    .select({ id: releases.id, builtAt: releases.builtAt })
    .from(releases)
    .where(eq(releases.id, operation.releaseId))
    .get();
  const newer = await newestFittingRelease(db, clientId, recorded);
  return newer ?? operation.releaseId;
};

/**
 * Places client `input.clientId`, as `staff`, unless it's placed already,
 * and starts provisioning it with `input.releaseId`, or resumes the
 * operation it has (`provisionPlacedClient`). Without a destination, the
 * automatic one (`automaticChoice`); a placed client stays where it is,
 * and another destination is refused (`placement_changed`). Everything is
 * checked before the client is placed, since a placement is for good:
 * that it runs in Grasp's cloud, is still being provisioned and isn't
 * being worked on, that the release is imported, and that the
 * destination is one the admin provisions in. Returns the attempt's id.
 */
export const placeAndProvision = async (
  env: Env,
  staff: Actor,
  input: PlaceInput
): Promise<string> => {
  const db = adminDatabase(env.DB);
  const { clientId } = input;
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
  // Grasp's cloud provisions only what it hosts: an on-prem install sets
  // itself up and connects (GRA-1291).
  const { hosting } = await clientHostingOf(db, clientId);
  if (hosting !== "grasp_cloud") {
    throw new PlacementError(
      "hosted_on_prem",
      `Client ${clientId} runs on its own premises`
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
  const releaseId = input.releaseId ?? (await resumeRelease(db, clientId));
  if (releaseId === null) {
    throw new PlacementError(
      "no_fitting_release",
      `No imported release fits ${clientId}`
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
    const choices = await destinationChoices(db);
    const destinationId =
      input.destinationId ?? automaticChoice(choices).destinationId;
    if (destinationId === null) {
      throw new PlacementError(
        "no_automatic_destination",
        `No one shared destination can take ${clientId}`
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
    await placeClient(db, staff, { clientId, destinationId });
  } else {
    // Placed already: where it is is no change; anything else is refused.
    await placeClient(db, staff, {
      clientId,
      destinationId: input.destinationId ?? placed.destinationId,
    });
  }
  return await provisionPlacedClient(env, staff, clientId, releaseId);
};

/** What each placement refusal says of why provisioning didn't start. */
const notStartedCodes: Readonly<Record<PlacementErrorCode, string>> = {
  no_automatic_destination: "no_destination",
  no_fitting_release: "no_release",
  other_run_held: "other_run_held",
  hosted_on_prem: "on_prem",
};

/** The destination the admin picks by itself for a client starting now. */
export const startDestination = async (
  db: AdminDatabase
): Promise<AutomaticChoice> => automaticChoice(await destinationChoices(db));

/**
 * Starts provisioning client `clientId`, as `staff`, when nothing keeps
 * it: in the automatic destination, with the newest release that fits it
 * (`placeAndProvision`). What adding a client does at once, so a client
 * with somewhere to go and a release to go with is never left waiting
 * for a click. Answers the attempt's id, or why it didn't start: no
 * destination or release (`NotStarted`), or the refusal's code.
 */
export const provisionIfReady = async (
  env: Env,
  staff: Actor,
  clientId: string
): Promise<
  { runId: string; notStarted: null } | { runId: null; notStarted: string }
> => {
  try {
    const runId = await placeAndProvision(env, staff, {
      clientId,
      releaseId: null,
      destinationId: null,
    });
    return { runId, notStarted: null };
  } catch (error) {
    if (error instanceof PlacementError) {
      return { runId: null, notStarted: notStartedCodes[error.code] };
    }
    if (
      error instanceof InventoryError ||
      error instanceof ProvisionOperationError ||
      error instanceof ProvisionError
    ) {
      return { runId: null, notStarted: error.code };
    }
    throw error;
  }
};
