/**
 * Every client's admin snapshot, as Grasp's admin reads it: its pages, its
 * chat and its MCP all read the same organizations from here. Each client's
 * core answers what it holds at `adminSnapshotPath` (core's
 * src/admin-snapshot.ts), asked as the grid asks for the onboarding summary
 * (onboarding.ts): through the router's route with the router secret,
 * signed with the key both derive from the client's auth secret, here for
 * the admin's purpose alone, and naming the staff member Access let in,
 * whom core's audit log records as the reader.
 *
 * Every client the console knows is read, the live set from D1 each time,
 * so one added since shows up at once; a few at a time, as the grid reads
 * (src/live-reads.ts), each within the grid's deadline from when its own
 * read starts, so one slow or failing core never holds up or fails the
 * others. A Worker request has only a few connections out at once and
 * queues the rest: read all at once, clients waiting in that queue would
 * spend their deadline there and show as timed out. A client whose core
 * doesn't answer stays in the list as not reachable, with when it last
 * answered and why it didn't now; one not deployed yet stays too, as not
 * deployed. Offboarded clients are left out: they have no core any more.
 *
 * The console holds no client data (@grasp-os/shared/onboarding-summary):
 * nothing of a snapshot is kept, only when each core last answered and the
 * latest failure's code (`clientAdminReads`).
 */
import {
  adminSnapshotPath,
  adminSnapshotPurpose,
  adminSnapshotSchema,
} from "@grasp-os/shared/admin-snapshot";
import type {
  AdminSnapshot,
  AdminSnapshotRequest,
} from "@grasp-os/shared/admin-snapshot";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import { toHex } from "@grasp-os/shared/encoding";
import { log } from "@grasp-os/shared/log";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { routerSecretHeader } from "@grasp-os/shared/router";
import { sql } from "drizzle-orm";

import type { Staff } from "../access.ts";
import { consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { clientAdminReads } from "../db/schema.ts";
import { deploySecrets } from "../deploy/context.ts";
import { errorCode } from "../deploy/deploy.ts";
import { clientAuthSecret } from "../deploy/secrets.ts";
import type { DeploySecrets } from "../deploy/secrets.ts";
import { defaultLiveReadLimits, eachLimited } from "../live-reads.ts";
import { clientGrid, healthTimeoutMs, ifStored, routeOf } from "./grid.ts";
import type { GridRow } from "./grid.ts";

const encoder = new TextEncoder();

/**
 * Why a client's snapshot wasn't read, as a code: what's kept of a failed
 * read, never a response body.
 * - `not_deployed`: still provisioning, so it has no core to ask;
 * - `no_route`: the router has no route to its core;
 * - `unconfigured`: the console can't sign or route for it (Secrets Store
 *   lacks the keys, or it has no client domain);
 * - `not_served`: its core answered 404, a release from before the snapshot;
 * - `refused`: its core refused the request (401, 403);
 * - `core_error`: its core answered another error;
 * - `invalid_answer`: its answer isn't a snapshot;
 * - `timeout`: no answer within the deadline;
 * - `no_answer`: the request failed otherwise.
 */
export type AdminReadError =
  | "not_deployed"
  | "no_route"
  | "unconfigured"
  | "not_served"
  | "refused"
  | "core_error"
  | "invalid_answer"
  | "timeout"
  | "no_answer";

/** One client's admin snapshot, or why it isn't here and since when. */
export type ClientAdmin =
  | {
      /** The client, as the grid shows it. */
      client: GridRow;
      state: "answered";
      snapshot: AdminSnapshot;
      /** When its core answered. */
      at: string;
    }
  | {
      client: GridRow;
      state: "unreachable";
      /** When its core last answered; null when it never has. */
      lastAnsweredAt: string | null;
      error: AdminReadError;
    };

/** What asking a client's core for its snapshot takes. */
export interface AdminSnapshotRequestOptions {
  coreUrl: string;
  routerSecret: string;
  /** The client's core auth secret, the signing key's source. */
  authSecret: string;
  /** The staff member asking, as Access verified them. */
  staff: Pick<Staff, "email">;
  signal: AbortSignal;
}

/** The code for a core's answer that isn't OK. */
const statusError = (status: number): AdminReadError => {
  if (status === 404) {
    return "not_served";
  }
  if (status === 401 || status === 403) {
    return "refused";
  }
  return "core_error";
};

/**
 * A client core's admin snapshot, signed for, or why it wasn't read.
 * Throws when the request fails without an answer (aborted, or no
 * connection).
 */
export const adminSnapshotOf = async ({
  coreUrl,
  routerSecret,
  authSecret,
  staff,
  signal,
}: AdminSnapshotRequestOptions): Promise<
  { snapshot: AdminSnapshot } | { error: AdminReadError }
> => {
  const request: AdminSnapshotRequest = {
    sentAt: new Date().toISOString(),
    staff: { email: staff.email },
  };
  const body = JSON.stringify(request);
  const key = await hkdfHmacKey(authSecret, adminSnapshotPurpose, ["sign"]);
  const signature = toHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)))
  );
  const response = await fetch(`${coreUrl}${adminSnapshotPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [routerSecretHeader]: routerSecret,
      [platformUpdateSignatureHeader]: signature,
    },
    body,
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    return { error: statusError(response.status) };
  }
  let answer: unknown = undefined;
  try {
    answer = await response.json();
  } catch {
    return { error: "invalid_answer" };
  }
  const parsed = adminSnapshotSchema.safeParse(answer);
  return parsed.success
    ? { snapshot: parsed.data }
    : { error: "invalid_answer" };
};

/** What reading one client takes, read once for every client. */
interface ReadSources {
  env: Env;
  staff: Staff;
  /** The keys clients' secrets derive from; null when Secrets Store doesn't have them. */
  secrets: DeploySecrets | null;
  timeoutMs: number;
}

/** What one client's read came to, before it's told with its history. */
type ReadOutcome =
  | { snapshot: AdminSnapshot; at: Date }
  | { error: AdminReadError };

/**
 * Client `row`'s snapshot, asked of its core within `timeoutMs` from when
 * this is called, never throwing.
 */
const readClient = async (
  { env, staff, secrets, timeoutMs }: ReadSources,
  row: GridRow
): Promise<ReadOutcome> => {
  if (row.status !== "active") {
    return { error: "not_deployed" };
  }
  if (secrets === null) {
    return { error: "unconfigured" };
  }
  const limit = deadline(timeoutMs);
  try {
    return await Promise.race([
      (async (): Promise<ReadOutcome> => {
        const route = await routeOf(
          env.ROUTER_HOSTS,
          secrets.routerKey,
          row.id,
          row.hostname
        );
        if (route === "no_route") {
          return { error: "no_route" };
        }
        if (route === "unknown") {
          return { error: "unconfigured" };
        }
        const read = await adminSnapshotOf({
          coreUrl: route.coreUrl,
          routerSecret: route.secret,
          authSecret: await clientAuthSecret(secrets, row.id, route.generation),
          staff,
          signal: limit.signal,
        });
        return "snapshot" in read
          ? { snapshot: read.snapshot, at: new Date() }
          : { error: read.error };
      })(),
      whenAborted(limit.signal),
    ]);
  } catch (error) {
    const timedOut = limit.stopped() === "timeout";
    log.warn("admin.snapshot_unread", {
      clientId: row.id,
      error: timedOut ? "timeout" : errorCode(error),
    });
    return { error: timedOut ? "timeout" : "no_answer" };
  } finally {
    limit.clear();
  }
};

/** When each client's core last answered, by id, as the console kept it. */
const lastAnswers = async (
  db: ConsoleDatabase
): Promise<Map<string, Date | null>> => {
  const rows = await db
    .select({
      clientId: clientAdminReads.clientId,
      lastAnsweredAt: clientAdminReads.lastAnsweredAt,
    })
    .from(clientAdminReads);
  return new Map(rows.map((row) => [row.clientId, row.lastAnsweredAt]));
};

/**
 * Keeps what each deployed client's read came to: when it answered, or
 * why it didn't. One not deployed yet has nothing to keep. Of two reads
 * at once, whichever lands last, a client keeps the latest answer's time,
 * and the error (or none) of the read asked last. A failure to keep it is
 * logged: the reads stand.
 */
const keepOutcomes = async (
  db: ConsoleDatabase,
  outcomes: readonly (readonly [string, ReadOutcome])[],
  askedAt: Date
): Promise<void> => {
  // Only a read asked no earlier than the kept one says why it failed, or
  // that it didn't. SQLite reads the kept row's columns before any is set.
  const newest = {
    error: sql`case when excluded.asked_at >= ${clientAdminReads.askedAt} then excluded.error else ${clientAdminReads.error} end`,
    askedAt: sql`max(${clientAdminReads.askedAt}, excluded.asked_at)`,
  };
  const statements = outcomes
    .filter(
      ([, outcome]) => !("error" in outcome && outcome.error === "not_deployed")
    )
    .map(([clientId, outcome]) => {
      if ("snapshot" in outcome) {
        return db
          .insert(clientAdminReads)
          .values({
            clientId,
            lastAnsweredAt: outcome.at,
            error: null,
            askedAt,
          })
          .onConflictDoUpdate({
            target: clientAdminReads.clientId,
            set: {
              lastAnsweredAt: sql`max(coalesce(${clientAdminReads.lastAnsweredAt}, 0), excluded.last_answered_at)`,
              ...newest,
            },
          });
      }
      return db
        .insert(clientAdminReads)
        .values({
          clientId,
          lastAnsweredAt: null,
          error: outcome.error,
          askedAt,
        })
        .onConflictDoUpdate({
          target: clientAdminReads.clientId,
          set: newest,
        });
    });
  const [first, ...rest] = statements;
  if (first === undefined) {
    return;
  }
  try {
    await db.batch([first, ...rest]);
  } catch (error) {
    log.warn("admin.reads_unkept", { error: errorCode(error) });
  }
};

/** How reading every client's snapshot may go. */
export interface AdminReadOptions {
  /** How many clients are read at once: the grid's. */
  concurrency: number;
  /**
   * How long one client may take all told, from when its read starts: the
   * grid's per-client deadline.
   */
  timeoutMs: number;
}

export const defaultAdminReadOptions: AdminReadOptions = {
  concurrency: defaultLiveReadLimits.concurrency,
  timeoutMs: healthTimeoutMs,
};

/**
 * Every client the console knows but those offboarded, each with its admin
 * snapshot as its core answers `staff` now, or as not reachable since it
 * last answered. Never throws for a client; every one is in the answer.
 */
export const clientAdmins = async (
  env: Env,
  staff: Staff,
  options: AdminReadOptions = defaultAdminReadOptions
): Promise<ClientAdmin[]> => {
  if (staff.email === "") {
    throw new Error("Reading clients' admin snapshots takes a staff member");
  }
  const db = consoleDatabase(env.DB);
  const grid = await clientGrid(env);
  const known = grid.filter(({ status }) => status !== "offboarded");
  const [lastAnswered, secrets] = await Promise.all([
    lastAnswers(db),
    ifStored(async (): Promise<DeploySecrets> => await deploySecrets(env)),
  ]);
  const askedAt = new Date();
  const sources: ReadSources = {
    env,
    staff,
    secrets,
    timeoutMs: options.timeoutMs,
  };
  // Each client's deadline starts inside its turn, not here: time spent
  // waiting for a turn isn't counted against it.
  const outcomes = await eachLimited(
    known,
    options.concurrency,
    async (row) => [row.id, await readClient(sources, row)] as const
  );
  await keepOutcomes(db, outcomes, askedAt);
  return known.map((client, index): ClientAdmin => {
    const outcome = outcomes[index]?.[1];
    if (outcome !== undefined && "snapshot" in outcome) {
      return {
        client,
        state: "answered",
        snapshot: outcome.snapshot,
        at: outcome.at.toISOString(),
      };
    }
    return {
      client,
      state: "unreachable",
      lastAnsweredAt: lastAnswered.get(client.id)?.toISOString() ?? null,
      error: outcome?.error ?? "no_answer",
    };
  });
};

/**
 * Every client's admin snapshot, read at most once however often it's
 * asked for: one per request, so a page whose sections each want the
 * organizations reads each client once. Nothing is kept across requests.
 */
export const adminReader = (
  env: Env,
  staff: Staff,
  options: AdminReadOptions = defaultAdminReadOptions
): (() => Promise<ClientAdmin[]>) => {
  let read: Promise<ClientAdmin[]> | undefined = undefined;
  return async () => {
    read ??= clientAdmins(env, staff, options);
    return await read;
  };
};
