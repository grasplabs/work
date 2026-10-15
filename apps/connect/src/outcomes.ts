import { actorOf } from "@grasp-os/shared/audit";
import type { AuditDetailValue, AuditEntry } from "@grasp-os/shared/audit";
import {
  capabilityErrors,
  verifyCapability,
} from "@grasp-os/shared/capability";
import type { CapabilityClaims } from "@grasp-os/shared/capability";
import {
  connectErrors,
  connectionPersonSchema,
  pendingKeySchema,
  refuseResolutionSchema,
  resolveOutcomeSchema,
  unknownOutcomeKeySchema,
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
import { isMemberAdmin, roleErrors } from "@grasp-os/shared/roles";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { recordEventIf, recordEvents } from "./audit.ts";
import { connectionFor, recoverableNow } from "./call.ts";
import { connections, idempotentCalls } from "./db/schema.ts";
import { isUnknown, originOf, resolution, unknownNow } from "./idempotency.ts";
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

/** Most calls of unknown outcome one list answers: the newest. */
const listLimit = 200;

/** The key of the call `row` records, as a list and a resolution name it. */
const keyOf = (row: Row): UnknownOutcomeKey =>
  unknownOutcomeKeySchema.parse({
    subject:
      row.subjectType === "app"
        ? { type: "app", appId: row.subjectId }
        : { type: "agent", agentId: row.subjectId },
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
  };
};

/** The rows of `person`'s, under `key` when given. */
/** The rows under `key`, whoever they acted for. */
const underKey = (key: UnknownOutcomeKey) =>
  and(
    eq(idempotentCalls.subjectType, key.subject.type),
    eq(
      idempotentCalls.subjectId,
      key.subject.type === "app" ? key.subject.appId : key.subject.agentId
    ),
    eq(idempotentCalls.connectionId, key.connectionId),
    eq(idempotentCalls.action, key.action),
    eq(idempotentCalls.idempotencyKey, key.idempotencyKey)
  );

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
 * most {@link listLimit}: none for Grasp staff, who act for nobody here.
 * One connect may still recover on its own is listed too: the person may
 * know better.
 */
export const listUnknownOutcomes = async (
  env: Env,
  request: unknown
): Promise<UnknownOutcome[]> => {
  const parsed = connectionPersonSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  if (parsed.data.staff) {
    return [];
  }
  const rows = await drizzle(env.DB)
    .select({ row: idempotentCalls, connection: shownConnection })
    .from(idempotentCalls)
    .leftJoin(connections, eq(connections.id, idempotentCalls.connectionId))
    .where(and(theirs(parsed.data), unknownNow(Date.now())))
    .orderBy(desc(idempotentCalls.createdAt))
    .limit(listLimit);
  return rows.map(summaryOf);
};

/**
 * What `row` shows an admin: never its input, key, claim or origin
 * (`UnknownOutcomeListing`). Its title is its tool's, which names the
 * action, never a value of what was sent.
 */
const listingOf = async ({
  row,
  connection,
}: {
  row: Row;
  connection: ShownConnection;
}): Promise<UnknownOutcomeListing> => {
  const title = descriptionOf(
    { action: row.action, input: {} },
    connection
  )?.title;
  return {
    // Only tells rows apart, of what the admin is shown anyway, and never
    // of its key: App code chooses keys and may put data in them, and a
    // digest of a key a reader can guess would confirm the guess. Two calls
    // alike in all of these, claimed in the same millisecond, share it until
    // `distinctIds` tells them apart.
    id: await sha256Hex(
      JSON.stringify([
        row.subjectType,
        row.subjectId,
        row.onBehalfOf,
        row.connectionId,
        row.action,
        row.claimedAt.getTime(),
      ])
    ),
    onBehalfOf: row.onBehalfOf,
    subject: keyOf(row).subject,
    connectionId: row.connectionId,
    connectionName: nameOf(connection),
    action: row.action,
    ...(title === undefined ? {} : { title }),
    resource: row.resource,
    sentAt: row.createdAt.toISOString(),
  };
};

/**
 * `listings` with every id told apart: a repeat of an id already given
 * gets its count after it, so a listing never names two rows alike.
 */
const distinctIds = (
  listings: UnknownOutcomeListing[]
): UnknownOutcomeListing[] => {
  const seen = new Map<string, number>();
  return listings.map((listing) => {
    const count = seen.get(listing.id) ?? 0;
    seen.set(listing.id, count + 1);
    return count === 0 ? listing : { ...listing, id: `${listing.id}-${count}` };
  });
};

/**
 * Every person's calls of unknown outcome, newest first, at most
 * {@link listLimit}, as an admin sees them (`listingOf`): only for one of
 * the organization's own admins, as core read them now; refused to anyone
 * else, Grasp staff included, who act for nobody here.
 */
export const listAllUnknownOutcomes = async (
  env: Env,
  request: unknown
): Promise<UnknownOutcomeListing[]> => {
  const parsed = connectionPersonSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  if (!isMemberAdmin(parsed.data)) {
    throw roleErrors.create("role.forbidden");
  }
  const rows = await drizzle(env.DB)
    .select({ row: idempotentCalls, connection: shownConnection })
    .from(idempotentCalls)
    .leftJoin(connections, eq(connections.id, idempotentCalls.connectionId))
    .where(unknownNow(Date.now()))
    .orderBy(desc(idempotentCalls.createdAt))
    .limit(listLimit);
  return distinctIds(await Promise.all(rows.map(listingOf)));
};

/** The person's call of unknown outcome `key` names, as stored, if any. */
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

/** What a resolution's events say of the call: identifiers, never input. */
const detailOf = async (
  key: UnknownOutcomeKey,
  choice: ResolutionChoice,
  row?: Row
): Promise<Record<string, AuditDetailValue>> => ({
  action: key.action,
  subjectType: key.subject.type,
  subjectId:
    key.subject.type === "app" ? key.subject.appId : key.subject.agentId,
  // App code chooses keys, so the log gets a hash, as for the call.
  idempotencyKeyHash: await sha256Hex(key.idempotencyKey),
  choice,
  ...(row === undefined
    ? {}
    : {
        resource: row.resource,
        onBehalfOf: row.onBehalfOf,
        inputHash: row.inputHash,
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
 * Whether `claims` are core's resolution of exactly the call `row`
 * records, by `choice`, for `person`, the person it acted for: the same
 * App or agent, the claim of its key it is now (one sent again since, and
 * lost again, is another call to decide on), and marked as a resolution,
 * never a call's or a held action's confirmation.
 */
const resolvesThis = (
  claims: CapabilityClaims,
  row: Row,
  person: ConnectionPerson,
  choice: ResolutionChoice
): boolean => {
  const { subject, onBehalfOf } = claims.authority;
  const subjectId = subject.type === "app" ? subject.appId : subject.agentId;
  return (
    claims.resolves?.choice === choice &&
    claims.resolves.claimedAt === row.claimedAt.getTime() &&
    claims.confirms === undefined &&
    onBehalfOf === person.userId &&
    onBehalfOf === row.onBehalfOf &&
    subject.type === row.subjectType &&
    subjectId === row.subjectId
  );
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
  const { capability, person, key, choice, claim } = parsed.data;
  const row = await unknownRowOf(env, person, key);
  if (row === undefined && !(await anyUnder(env, key))) {
    // No call was ever made under it: nothing to record a refusal of.
    throw connectErrors.create("connect.outcome_not_found");
  }
  try {
    // Not the claim of its key the person was shown: sent again since,
    // and lost again, it is another call to decide on.
    if (row === undefined || row.claimedAt.getTime() !== claim) {
      throw connectErrors.create("connect.outcome_not_found");
    }
    // What was sent is no longer kept (retention): "it didn't" would let
    // it go out again unread, so only "it happened" is said (core checks
    // this too, on its earlier read).
    if (choice === "not_happened" && row.input === null) {
      throw connectErrors.create("connect.outcome_not_kept");
    }
    const claims = await verifyCapability(signingKeys, capability, {
      connectionId: row.connectionId,
      resource: row.resource ?? undefined,
      action: row.action,
      idempotencyKey: row.idempotencyKey,
    });
    if (!resolvesThis(claims, row, person, choice)) {
      throw capabilityErrors.create("capability.invalid", {
        reason: "scope",
      });
    }
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
