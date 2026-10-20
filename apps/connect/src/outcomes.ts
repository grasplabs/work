import { actorOf } from "@grasp-os/shared/audit";
import type { AuditDetailValue, AuditEntry } from "@grasp-os/shared/audit";
import {
  capabilityErrors,
  verifyCapability,
} from "@grasp-os/shared/capability";
import {
  connectErrors,
  connectionPersonSchema,
  pendingKeySchema,
  refuseResolutionSchema,
  resolveOutcomeSchema,
  unknownOutcomeCursorSchema,
  unknownOutcomeKeySchema,
  unknownOutcomeListLimit,
  unknownOutcomeRequestSchema,
} from "@grasp-os/shared/connect";
import type {
  ConnectCall,
  ConnectionPerson,
  ResolutionChoice,
  UnknownOutcome,
  UnknownOutcomeKey,
  UnknownOutcomeListing,
} from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  codeSubjectId,
  codeSubjectOf,
  codeSubjectSchema,
} from "@grasp-os/shared/permissions";
import { isMemberAdmin, roleErrors } from "@grasp-os/shared/roles";
import { and, desc, eq, lt, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { recordEventIf, recordEvents } from "./audit.ts";
import { connectionFor, recoverableNow } from "./call.ts";
import { connections, idempotentCalls } from "./db/schema.ts";
import { requireDecision } from "./decisions.ts";
import {
  effectKeyHashOfRow,
  isUnknown,
  originOf,
  resolution,
  unknownNow,
} from "./idempotency.ts";
import type { Row } from "./idempotency.ts";
import { descriptionOf, nameOf, shownConnection } from "./pending.ts";
import type { ShownConnection } from "./pending.ts";

// Calls of unknown outcome, as open obligations of the person each acted
// for (spec 14.3): listed for them, with what was sent, and resolved by
// their word, through core, from their own session. The threat model is
// idempotency.ts's, under "Resolution by a person". What the person says
// is recorded (`connection.call.resolved`, with their choice) as their
// word, in one batch with the change it makes: never as a send, never as
// an effect undone.

const listLimit = unknownOutcomeListLimit;

/**
 * The cursor of the call `row` records: its first send and its random
 * list ID, so it says nothing of anyone else's calls (not how many were
 * made in between, as a row number would) and stays where it is, whatever
 * the database does with its rows.
 */
const cursorOf = (row: Pick<Row, "createdAt" | "listId">): string =>
  `${row.createdAt.getTime()}.${row.listId}`;

/**
 * The calls listed after `before`, in the order lists go (newest first,
 * then by list ID), or every one without it. Throws `connect.invalid` for a
 * cursor no list gave.
 */
const after = (before: unknown): SQL | undefined => {
  if (before === undefined) {
    return undefined;
  }
  const parsed = unknownOutcomeCursorSchema.safeParse(before);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const [time = "0", listId = ""] = parsed.data.split(".");
  const at = new Date(Number(time));
  return or(
    lt(idempotentCalls.createdAt, at),
    and(eq(idempotentCalls.createdAt, at), lt(idempotentCalls.listId, listId))
  );
};

/** The order lists go in: newest first, then by list ID. */
const listOrder = [
  desc(idempotentCalls.createdAt),
  desc(idempotentCalls.listId),
];

/** The key of the call `row` records, as a list and a resolution name it. */
const keyOf = (row: Row): UnknownOutcomeKey =>
  unknownOutcomeKeySchema.parse({
    subject: codeSubjectOf(row.subjectType, row.subjectId),
    connectionId: row.connectionId,
    action: row.action,
    idempotencyKey: row.idempotencyKey,
  });

/** The input `row` keeps, parsed, or undefined when it keeps none. */
const inputOf = (row: Row): ConnectCall["input"] | undefined => {
  if (row.input === null) {
    return undefined;
  }
  try {
    return z.json().parse(JSON.parse(row.input));
  } catch {
    return undefined;
  }
};

const summaryOf = ({
  row,
  connection,
}: {
  row: Row;
  connection: ShownConnection;
}): UnknownOutcome => {
  const input = inputOf(row);
  const description =
    input === undefined
      ? undefined
      : descriptionOf({ action: row.action, input }, connection);
  const origin = originOf(row);
  return {
    key: keyOf(row),
    connectionName: nameOf(connection),
    resource: row.resource,
    ...(description === undefined ? {} : { description }),
    input: row.input,
    sentAt: row.createdAt.toISOString(),
    claim: row.claimedAt.getTime(),
    origin:
      origin === null
        ? null
        : {
            mode: origin.mode,
            appVersion: origin.appVersion,
            permissionId: origin.permissionId,
            context: origin.context,
            ...(origin.binding === undefined
              ? {}
              : { binding: origin.binding }),
          },
    cursor: cursorOf(row),
  };
};

/** The rows under `key`, whoever they acted for. */
const underKey = (key: UnknownOutcomeKey) =>
  and(
    eq(idempotentCalls.subjectType, key.subject.type),
    eq(idempotentCalls.subjectId, codeSubjectId(key.subject)),
    eq(idempotentCalls.connectionId, key.connectionId),
    eq(idempotentCalls.action, key.action),
    eq(idempotentCalls.idempotencyKey, key.idempotencyKey)
  );

/** The rows of `person`'s, under `key` when given. */
const theirs = (person: ConnectionPerson, key?: UnknownOutcomeKey) =>
  and(
    eq(idempotentCalls.onBehalfOf, person.userId),
    key === undefined ? undefined : underKey(key)
  );

/** Whether any call was made under `key`, for anyone. */
const anyUnder = async (env: Env, key: UnknownOutcomeKey): Promise<boolean> => {
  const row = await drizzle(env.DB)
    .select({ state: idempotentCalls.state })
    .from(idempotentCalls)
    .where(underKey(key))
    .get();
  return row !== undefined;
};

/**
 * The calls of unknown outcome that acted for `person`, newest first, at
 * most {@link listLimit} a page, the next page `before` the last one's
 * cursor: none for Grasp staff, who act for nobody here. One connect may
 * still recover on its own is listed too: the person may know better.
 */
export const listUnknownOutcomes = async (
  env: Env,
  request: unknown,
  before?: unknown
): Promise<UnknownOutcome[]> => {
  const parsed = connectionPersonSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const page = after(before);
  if (parsed.data.staff) {
    return [];
  }
  const rows = await drizzle(env.DB)
    .select({ row: idempotentCalls, connection: shownConnection })
    .from(idempotentCalls)
    .leftJoin(connections, eq(connections.id, idempotentCalls.connectionId))
    .where(and(theirs(parsed.data), unknownNow(Date.now()), page))
    .orderBy(...listOrder)
    .limit(listLimit);
  return rows.map(summaryOf);
};

/**
 * The columns an admin's listing reads (`listingOf`): never the input,
 * which may be large, nor the origin, which it never shows; the key only
 * for its receipt's hash, never shown itself.
 */
const listingColumns = {
  idempotencyKey: idempotentCalls.idempotencyKey,
  subjectType: idempotentCalls.subjectType,
  subjectId: idempotentCalls.subjectId,
  onBehalfOf: idempotentCalls.onBehalfOf,
  connectionId: idempotentCalls.connectionId,
  action: idempotentCalls.action,
  claimedAt: idempotentCalls.claimedAt,
  resource: idempotentCalls.resource,
  createdAt: idempotentCalls.createdAt,
  listId: idempotentCalls.listId,
};

type ListingRow = Pick<Row, keyof typeof listingColumns>;

/**
 * What `row` shows an admin: never its input, key, claim or origin
 * (`UnknownOutcomeListing`). Its title is its tool's, which names the
 * action, never a value of what was sent.
 */
const listingOf = async ({
  row,
  connection,
}: {
  row: ListingRow;
  connection: ShownConnection;
}): Promise<UnknownOutcomeListing> => {
  const title = descriptionOf(
    { action: row.action, input: {} },
    connection
  )?.title;
  return {
    // The receipt the audit log names the call by, as its events do: the
    // admin reads the same hash there, with the key's own.
    effectKeyHash: await effectKeyHashOfRow(row),
    // Only tells rows apart, of what the admin is shown anyway and the
    // row's random list ID, and never of its key: App code chooses keys and
    // may put data in them, and a digest of a key a reader can guess would
    // confirm the guess. The list ID makes it unique across every page,
    // even for two calls alike in all the rest, claimed in the same
    // millisecond.
    id: await sha256Hex(
      JSON.stringify([
        row.subjectType,
        row.subjectId,
        row.onBehalfOf,
        row.connectionId,
        row.action,
        row.claimedAt.getTime(),
        row.listId,
      ])
    ),
    onBehalfOf: row.onBehalfOf,
    subject: codeSubjectSchema.parse(
      row.subjectType === "app"
        ? { type: "app", appId: row.subjectId }
        : { type: "agent", agentId: row.subjectId }
    ),
    connectionId: row.connectionId,
    connectionName: nameOf(connection),
    action: row.action,
    ...(title === undefined ? {} : { title }),
    resource: row.resource,
    sentAt: row.createdAt.toISOString(),
    cursor: cursorOf(row),
  };
};

/**
 * Every person's calls of unknown outcome, newest first, paged as
 * `listUnknownOutcomes` is, as an admin sees them (`listingOf`): only for
 * one of the organization's own admins, as core read them now; refused to
 * anyone else, Grasp staff included, who act for nobody here.
 */
export const listAllUnknownOutcomes = async (
  env: Env,
  request: unknown,
  before?: unknown
): Promise<UnknownOutcomeListing[]> => {
  const parsed = connectionPersonSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  if (!isMemberAdmin(parsed.data)) {
    throw roleErrors.create("role.forbidden");
  }
  const rows = await drizzle(env.DB)
    .select({ row: listingColumns, connection: shownConnection })
    .from(idempotentCalls)
    .leftJoin(connections, eq(connections.id, idempotentCalls.connectionId))
    .where(and(unknownNow(Date.now()), after(before)))
    .orderBy(...listOrder)
    .limit(listLimit);
  return await Promise.all(rows.map(listingOf));
};

/**
 * The person's call of unknown outcome `key` names, as stored, with its
 * row's number, if any.
 */
const unknownRowOf = async (
  env: Env,
  person: ConnectionPerson,
  key: UnknownOutcomeKey
): Promise<Row | undefined> => {
  if (person.staff) {
    return undefined;
  }
  const row = await drizzle(env.DB)
    .select()
    .from(idempotentCalls)
    .where(theirs(person, key))
    .get();
  return row !== undefined && isUnknown(row, Date.now()) ? row : undefined;
};

/** One call of unknown outcome of the person's, or `null`. */
export const unknownOutcomeFor = async (
  env: Env,
  request: unknown
): Promise<UnknownOutcome | null> => {
  const parsed = unknownOutcomeRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const row = await unknownRowOf(env, parsed.data.person, parsed.data.key);
  if (row === undefined) {
    return null;
  }
  const connection = await drizzle(env.DB)
    .select(shownConnection)
    .from(connections)
    .where(eq(connections.id, row.connectionId))
    .get();
  return summaryOf({ row, connection: connection ?? null });
};

/** What a resolution's events say of the call: identifiers, never input or its hash. */
const detailOf = async (
  key: UnknownOutcomeKey,
  choice: ResolutionChoice,
  row?: Row
): Promise<Record<string, AuditDetailValue>> => ({
  action: key.action,
  subjectType: key.subject.type,
  subjectId: codeSubjectId(key.subject),
  // App code chooses keys, so the log gets a hash, as for the call.
  idempotencyKeyHash: await sha256Hex(key.idempotencyKey),
  choice,
  ...(row === undefined
    ? {}
    : {
        resource: row.resource,
        onBehalfOf: row.onBehalfOf,
        // The receipt, as the call's own events name it: what the
        // resolution closes.
        effectKeyHash: await effectKeyHashOfRow(row),
        // Never the input's hash: unsalted, it would let a reader of the
        // log guess a short value the input held (a workflow's sensitive
        // parameter), and the key's hash with the claim names the call.
      }),
});

const resolutionEvent = async (
  person: ConnectionPerson,
  action: string,
  key: UnknownOutcomeKey,
  choice: ResolutionChoice,
  extra: Record<string, AuditDetailValue>,
  row?: Row
): Promise<AuditEntry> => ({
  actor: actorOf(person),
  action,
  target: { type: "connection", id: key.connectionId },
  detail: { ...(await detailOf(key, choice, row)), ...extra },
});

/**
 * Records a resolution that was refused; if that fails too, it is logged:
 * the person learns why it was refused.
 */
const auditRefused = async (
  env: Env,
  person: ConnectionPerson,
  key: UnknownOutcomeKey,
  choice: ResolutionChoice,
  reason: string,
  row?: Row
): Promise<void> => {
  try {
    await recordEvents(env, [
      await resolutionEvent(
        person,
        "connection.call.resolve_refused",
        key,
        choice,
        { reason },
        row
      ),
    ]);
  } catch (error) {
    log.error("audit.record_failed", errorFields(error));
  }
};

/** Records a resolution core refused before it reached connect. */
export const refuseResolution = async (
  env: Env,
  request: unknown
): Promise<void> => {
  const parsed = refuseResolutionSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const { person, key, choice, reason } = parsed.data;
  await auditRefused(env, person, key, choice, reason);
};

/**
 * Resolves a call of unknown outcome by its person's word, with the
 * capability core signed for that resolution once it checked the call's
 * permission again: only for the person it acted for, on a connection
 * they may still use, and only while it is still of unknown outcome as
 * read (`resolution`), recorded in the same batch. Every refusal is
 * recorded, and leaves the call as it was.
 */
export const resolveOutcome = async (
  env: Env,
  signingKeys: readonly string[],
  request: unknown
): Promise<void> => {
  const parsed = resolveOutcomeSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const { capability, person, key, choice } = parsed.data;
  const row = await unknownRowOf(env, person, key);
  if (row === undefined && !(await anyUnder(env, key))) {
    // No call was ever made under it: nothing to record a refusal of.
    throw connectErrors.create("connect.outcome_not_found");
  }
  try {
    if (row === undefined) {
      throw connectErrors.create("connect.outcome_not_found");
    }
    const claims = await verifyCapability(signingKeys, capability, {
      connectionId: row.connectionId,
      resource: row.resource ?? undefined,
      action: row.action,
      idempotencyKey: row.idempotencyKey,
    });
    // Not the claim of its key the person was shown: sent again since,
    // and lost again, it is another call to decide on.
    const claimedAt = row.claimedAt.getTime();
    if (
      claims.decision?.kind === "resolve" &&
      claims.decision.claimedAt !== claimedAt
    ) {
      throw connectErrors.create("connect.outcome_not_found");
    }
    // What was sent is no longer kept (retention): "it didn't" would let
    // it go out again unread, so only "it happened" is said (core checks
    // this too, on its earlier read).
    if (choice === "not_happened" && row.input === null) {
      throw connectErrors.create("connect.outcome_not_kept");
    }
    requireDecision(claims, {
      decision: { kind: "resolve", choice, claimedAt },
      person,
      call: {
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        onBehalfOf: row.onBehalfOf,
        origin: originOf(row),
      },
    });
    await connectionFor(env, claims, row.connectionId);
  } catch (error) {
    await auditRefused(
      env,
      person,
      key,
      choice,
      connectErrors.codeOf(error) ??
        capabilityErrors.codeOf(error) ??
        "internal",
      row
    );
    throw error;
  }
  const { where, write } = resolution(env.DB, row, choice, Date.now());
  const recorded = await recordEventIf(
    env,
    await resolutionEvent(
      person,
      "connection.call.resolved",
      key,
      choice,
      {},
      row
    ),
    { from: idempotentCalls, where },
    [write]
  );
  if (!recorded) {
    // A recovery or another resolution took it since it was read.
    await auditRefused(
      env,
      person,
      key,
      choice,
      "connect.outcome_not_found",
      row
    );
    throw connectErrors.create("connect.outcome_not_found");
  }
};

/**
 * Whether a call under idempotency key `idempotencyKey`, acting for
 * `onBehalfOf`, is of unknown outcome, unresolved, and wouldn't be
 * recovered by the same call made again now (`recoverableNow`): a run's
 * step that got its unknown outcome waits while one is. Only a native
 * connector's: a Composio tool's error, whose text nobody is shown yet,
 * fails the step (GRA-560), though it stays listed for its person.
 */
export const unresolvedUnder = async (
  env: Env,
  request: unknown
): Promise<boolean> => {
  const parsed = pendingKeySchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const rows = await drizzle(env.DB)
    .select({ row: idempotentCalls })
    .from(idempotentCalls)
    .innerJoin(connections, eq(connections.id, idempotentCalls.connectionId))
    .where(
      and(
        eq(idempotentCalls.onBehalfOf, parsed.data.onBehalfOf),
        eq(idempotentCalls.idempotencyKey, parsed.data.idempotencyKey),
        eq(connections.serverKind, "native"),
        unknownNow(Date.now())
      )
    );
  if (parsed.data.orRecoverable === true) {
    return rows.length > 0;
  }
  // Every one under the step's key: a step makes few calls, each its own
  // row, and the first that waits for its person settles it.
  for (const { row } of rows) {
    // oxlint-disable-next-line no-await-in-loop -- stops at the first
    if (!(await recoverableNow(env, row))) {
      return true;
    }
  }
  return false;
};
