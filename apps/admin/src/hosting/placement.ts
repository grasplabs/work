/**
 * Where a client runs, and starting its provisioning there (spec 37.3,
 * 40.1): placing the client and starting (or resuming) its one operation.
 *
 * There is one hosting destination per stage, fixed in code: Grasp's
 * account and the stage's clients' Workers for Platforms namespace
 * (@grasp-os/shared/names). Every Grasp Cloud organization goes there. An
 * on-prem organization is placed nowhere: its install sets itself up
 * (GRA-1291).
 */
import {
  clientsNamespace,
  platformAccountId,
  stageNamed,
} from "@grasp-os/shared/names";
import type { Stage } from "@grasp-os/shared/names";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { actIfChanged, adminDatabase } from "../db/act.ts";
import type { Actor, AdminDatabase } from "../db/act.ts";
import { clients, hostingDestinations, releases } from "../db/schema.ts";
import { importedManifest } from "../deploy/release.ts";
import { ProvisionError } from "../provision/errors.ts";
import { currentRun, hasEnded } from "../runners.ts";
import type { RunStatus } from "../runners.ts";
import { InventoryError, placeClient, placementOf } from "./inventory.ts";
import type { InventoryErrorCode } from "./inventory.ts";
import {
  newestRelease,
  ProvisionOperationError,
  provisionOf,
} from "./operation.ts";
import type { ProvisionOperationErrorCode } from "./operation.ts";
import { clientHostingOf } from "./organization.ts";
import type { OrganizationHosting } from "./organization.ts";
import { provisionPlacedClient } from "./workflow.ts";

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
  /**
   * Where it goes, or is: its placement's destination, else its stage's
   * (`stageDestinationId`); null on an admin whose STAGE names no stage.
   */
  destinationId: string | null;
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
   * The newest imported release (`newestRelease`): what starting or
   * resuming offers first; null when none is imported.
   */
  suggestedReleaseId: string | null;
  /**
   * Why its provisioning hasn't started, while it has no operation: no
   * destination to place it in, or no release it may be provisioned with. Null once it has one, or when nothing keeps it.
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

/** The id of `stage`'s own shared destination, as its admin records it. */
export const stageDestinationId = (stage: Stage): string =>
  `workers-for-platforms-${stage}`;

/** This admin's stage's destination; null when its STAGE names no stage. */
export const stageDestinationOf = (env: Pick<Env, "STAGE">): string | null => {
  const stage = stageNamed(env.STAGE);
  return stage === undefined ? null : stageDestinationId(stage);
};

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
 * no placement can skip. It runs once: the destination, once recorded,
 * is left as it is.
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
  const now = new Date();
  // Insert only, never over the one with its id: two reads at once create
  // it once, audited once.
  await actIfChanged(
    db,
    "system",
    db
      .insert(hostingDestinations)
      .values({
        id,
        accountId: platformAccountId,
        namespace,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing(),
    {
      action: "destination.create",
      target: id,
      detail: { namespace },
    }
  );
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
 * own premises, which Grasp's cloud doesn't provision (`on_prem`); the
 * admin's STAGE names no stage, so it has no destination
 * (`no_destination`); or no imported release fits it (`no_release`).
 */
export type NotStarted = "on_prem" | "no_destination" | "no_release";

/** What keeps client `clientId`'s provisioning from starting, given what it would start with. */
export const notStartedOf = (
  hosting: OrganizationHosting,
  destinationId: string | null,
  suggestedReleaseId: string | null
): NotStarted | null => {
  if (hosting.hosting !== "grasp_cloud") {
    return "on_prem";
  }
  if (destinationId === null) {
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
  const placement = await placementOf(db, clientId);
  const hosting = await clientHostingOf(db, clientId);
  const operation = await provisionOf(db, clientId);
  const current = await currentRun(env, clientId);
  const attempt = attemptOf(current, operation?.status);
  const destinationId = placement?.destinationId ?? stageDestinationOf(env);
  const suggestedReleaseId =
    client.status === "provisioning" && hosting.hosting === "grasp_cloud"
      ? await newestRelease(db)
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
    destinationId,
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
        ? notStartedOf(hosting, destinationId, suggestedReleaseId)
        : null,
    run: attempt,
    going: attempt !== null && !hasEnded(attempt),
  };
};

export const placementErrorCodes = [
  /** The admin's STAGE names no stage, so it has no destination to place in. */
  "no_destination",
  /**
   * The client's last run was another kind's (provisioning in an account of
   * its own): placing it would take that run's claim, so it could never resume.
   */
  "other_run_held",
  /** No release was chosen, and none is imported (`newestRelease`). */
  "no_release",
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
 * imported), in its stage's destination.
 */
export const placeInputSchema = z.object({
  clientId: z.string().min(1),
  releaseId: z.string().min(1).nullable(),
});

export type PlaceInput = z.infer<typeof placeInputSchema>;

/**
 * The release a provisioning started or tried again without one picked
 * runs with: the newest imported release (`newestRelease`). For one with
 * an operation, the newest built after its recorded release, so a fix
 * released since moves it forward; with none newer, its recorded release,
 * so it is never left without one.
 */
const resumeRelease = async (
  db: AdminDatabase,
  clientId: string
): Promise<string | null> => {
  const operation = await provisionOf(db, clientId);
  if (operation === undefined) {
    return await newestRelease(db);
  }
  const recorded = await db
    .select({ id: releases.id, builtAt: releases.builtAt })
    .from(releases)
    .where(eq(releases.id, operation.releaseId))
    .get();
  const newer = await newestRelease(db, recorded);
  return newer ?? operation.releaseId;
};

/**
 * Places client `input.clientId`, as `staff`, unless it's placed already,
 * and starts provisioning it with `input.releaseId`, or resumes the
 * operation it has (`provisionPlacedClient`). An unplaced client goes in
 * its stage's destination; a placed one stays where it is. Everything is
 * checked before the client is placed, since a placement is for good:
 * that it runs in Grasp's cloud, is still being provisioned and isn't
 * being worked on, and that the release is imported. Returns the
 * attempt's id.
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
      "no_release",
      `No release is imported to provision ${clientId} with`
    );
  }
  if ((await importedManifest(db, releaseId)) === null) {
    throw new ProvisionOperationError(
      "release_not_imported",
      `Release ${releaseId} isn't imported`
    );
  }
  if ((await placementOf(db, clientId)) === undefined) {
    const destinationId = stageDestinationOf(env);
    if (destinationId === null) {
      throw new PlacementError(
        "no_destination",
        "This admin's STAGE names no stage, so it has no destination"
      );
    }
    await ensureStageDestination(env, db);
    await placeClient(db, staff, { clientId, destinationId });
  }
  return await provisionPlacedClient(env, staff, clientId, releaseId);
};

/** What each placement refusal says of why provisioning didn't start. */
const notStartedCodes: Readonly<Record<PlacementErrorCode, string>> = {
  no_destination: "no_destination",
  no_release: "no_release",
  other_run_held: "other_run_held",
  hosted_on_prem: "on_prem",
};

/**
 * Starts provisioning client `clientId`, as `staff`, when nothing keeps
 * it: in its stage's destination, with the newest release
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
