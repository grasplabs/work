import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { drizzle } from "drizzle-orm/d1";

import { keepAuditEvent } from "./audit-outbox.ts";
import type { SensitiveRead, SensitiveReadsSink } from "./operations.ts";

// Reads of a table its schema declares sensitive (`defineTable(...)
// .sensitive()`, sticky in the store's `sdk_tables.sensitive`), recorded
// in the audit log as `app.data.read`: who read which table, through which
// function, and how many of its records. Code that runs for a person may
// copy what that person can read into a table with looser rules; that is
// inherent to code acting for a person, so it is allowed and recorded
// rather than refused.
//
// Threat model, and how each is closed:
//
// - App code reads a sensitive table off the record: what a read answered
//   is counted by the store itself, in the read's own transaction
//   (store-host.ts, `#readIn`), and handed to the operation host, never
//   to App code; the host keeps the record once the call is over,
//   answered or failed, thrown, timed out or cancelled alike
//   (operations.ts, `callOperation`). Every read App code makes goes
//   through that host, live queries' reads again on each push and the
//   functions a call nests included.
// - App code hides a read in a failure: a read that failed after it
//   looked at records (`data.not_unique`, a conflict) is counted as one
//   that answered, from what the store added to the error.
// - Probing without reading: a read that answered none of a sensitive
//   table's records is recorded too, with no rows, since a filter on its
//   fields that matched nothing still tells something of what they hold.
// - The log flooded, or reads made dear: one event a function and table
//   for a whole call, however many reads and records, made once it ends;
//   a read of no sensitive table costs nothing more than before.
// - The record says more than it should: identifiers and counts only,
//   never a record, a field or a filter.
//
// The data browser of an App's page reads the store directly, without the
// operation host, and records its own reads the same way (app-data.ts).

/** Whom a call's sensitive reads are recorded for, and what they read. */
export interface SensitiveReadContext {
  readonly actor: AuditActor;
  /** What was read: the App, or the store of a store operation. */
  readonly target: { readonly type: "app" | "store"; readonly id: string };
  readonly version: number;
  /** The person the call acts for. */
  readonly principal: string;
  /** The request it was made in; none for an App page's own (app-data.ts). */
  readonly requestId?: string;
  readonly runId: string | null;
}

/**
 * Reads of one sensitive table, by what made them: an App's function
 * (its path), or an App page's data browser or export, which run none.
 */
export type SensitiveTableRead = Pick<
  SensitiveRead,
  "table" | "reads" | "rows"
> &
  (
    | { readonly via: "function"; readonly function: string }
    | { readonly via: "browser" | "export" }
  );

/** The `app.data.read` event of `read`. */
export const sensitiveReadEntry = (
  { actor, target, version, principal, requestId, runId }: SensitiveReadContext,
  read: SensitiveTableRead
): AuditEntry => ({
  actor,
  action: "app.data.read",
  target: { ...target },
  ...(requestId === undefined ? {} : { requestId }),
  detail: {
    version,
    person: principal,
    runId,
    via: read.via,
    function: read.via === "function" ? read.function : null,
    table: read.table,
    reads: read.reads,
    rows: read.rows,
  },
});

/**
 * Keeps `reads` as `app.data.read` events through the audit outbox; never
 * throws (`keepAuditEvent`).
 */
export const keepSensitiveReads = async (
  env: Env,
  context: SensitiveReadContext,
  reads: readonly SensitiveTableRead[]
): Promise<void> => {
  await Promise.all(
    reads.map(async (read) => {
      await keepAuditEvent(
        env,
        drizzle(env.DB),
        sensitiveReadEntry(context, read)
      );
    })
  );
};

/**
 * How a call keeps what it read of sensitive tables
 * (`Invocation.sensitiveReads`): one `app.data.read` for each function and
 * table, through the audit outbox, and never failing the call.
 */
export const keptSensitiveReads =
  (env: Env, context: SensitiveReadContext): SensitiveReadsSink =>
  async (reads) => {
    await keepSensitiveReads(
      env,
      context,
      reads.map((read) => ({ ...read, via: "function" }))
    );
  };
