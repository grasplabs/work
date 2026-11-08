import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { toBase64, toHex } from "@grasp-os/shared/encoding";
import {
  eventSourceCreateSchema,
  eventSourceErrors,
} from "@grasp-os/shared/event-sources";
import type {
  EventSource,
  EventSourceWithSecret,
} from "@grasp-os/shared/event-sources";
import { identifierSchema } from "@grasp-os/shared/ids";
import { isAdmin, requireAdmin, requireBuilder } from "@grasp-os/shared/roles";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxed, outboxedIfChanged } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import { eventSources } from "./db/core/schema.ts";
import { derivedHmacKey } from "./derived-keys.ts";
import { requireNotStaff } from "./sharing.ts";

// Event sources (GRA-1560): where an outside system sends events into the
// deployment, one per sender ("Stripe", "Shop system"), each an admin's
// to create, with one URL and one secret. Webhook triggers start
// workflows on a source's event types (trigger-resources.ts); how a
// delivery is checked and becomes an event is workflows/source-events.ts,
// whose threat model covers the endpoint. This registry's, written before
// the code:
//
// - Someone but an admin deciding what may send events in. Only an admin
//   creates, rotates, revokes or deletes a source, never Grasp staff, who
//   only manage (`requireAdmin`, `requireNotStaff`); each change is
//   audited. A source grants nothing by itself: a trigger on it starts a
//   workflow only once an admin grants that trigger `start`, naming the
//   source and the event type it starts on (permissions-open.ts).
// - The URL leaking. It ends in 128 random bits of the source's own,
//   never its ID (which builders and the audit log see), and is shown to
//   admins alone: builders list a source by name to start a workflow on
//   it, never its URL. It is not the credential: every delivery must be
//   signed with the source's secret.
// - The secret leaking from core. It is never stored: it is derived from
//   the source's ID and its secret's generation with a key of core's own
//   (`derivedHmacKey`), answered once to the admin who made it (created or
//   rotated), never listed, logged or audited. Rotating makes a new
//   generation, never one used before, so the old secret takes nothing
//   from then on; revoking takes nothing until a new one is made; deleting
//   the source clears its token, so its URL answers as one nobody has, and
//   the events it kept for waits reached later are taken by nothing from
//   then on, deleted on the clock (workflows/event-waits.ts).
//   Rotating core's auth secret changes them all. A delivery checked with
//   a secret rotated, revoked or deleted while it was admitted starts
//   nothing (source-events.ts).

const secretPurpose = "grasp-os event source secret";

/** The prefix of a Standard Webhooks secret: its key follows, in base64. */
const secretPrefix = "whsec_";

/** Random bytes in a source's token. */
const tokenBytes = 16;

/** The key of source `id`'s secret at `generation`: never stored. */
export const sourceSecretKeyOf = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  id: string,
  generation: number
): Promise<Uint8Array<ArrayBuffer>> => {
  const key = await derivedHmacKey(env, secretPurpose, ["sign"]);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}\n${generation}`)
  );
  return new Uint8Array(mac);
};

/**
 * The secret of source `id` at `generation`, as Standard Webhooks writes
 * one: `whsec_` and its 32-byte key, in base64. Never stored.
 */
const secretOf = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  id: string,
  generation: number
): Promise<string> =>
  `${secretPrefix}${toBase64(await sourceSecretKeyOf(env, id, generation))}`;

const unavailable = () =>
  eventSourceErrors.create("webhook.source_unavailable");

const entry = (
  by: Acting,
  action: string,
  id: string,
  detail: AuditEntry["detail"] = {}
): AuditEntry => ({
  actor: by.actor ?? actorOf(by),
  action,
  target: { type: "event_source", id },
  detail,
});

/** A source's row, as `viewOf` reads it. */
type SourceRow = typeof eventSources.$inferSelect;

/** Source `row` as `by` sees it: its URL's token for an admin alone. */
const viewOf = (row: SourceRow, admin: boolean): EventSource => ({
  id: row.id,
  name: row.name,
  createdAt: row.createdAt.toISOString(),
  createdBy: row.createdBy,
  delivery:
    admin && row.token !== null
      ? {
          token: row.token,
          secret: row.secretRevokedAt === null ? "active" : "revoked",
        }
      : null,
});

/** The live source `id`, if there is one. */
const liveSource = async (
  env: Env,
  id: unknown
): Promise<SourceRow | undefined> => {
  const parsed = identifierSchema.safeParse(id);
  if (!parsed.success) {
    return undefined;
  }
  return await drizzle(env.DB)
    .select()
    .from(eventSources)
    .where(
      and(eq(eventSources.id, parsed.data), isNull(eventSources.deletedAt))
    )
    .get();
};

/** Refuses anyone but an admin who isn't Grasp staff. */
const requireSourceAdmin = (by: Acting): void => {
  requireAdmin(by);
  requireNotStaff(by);
};

/** The live sources, oldest first, for an admin or a builder (`EventSourcesApi.list`). */
export const listEventSources = async (
  env: Env,
  by: Acting
): Promise<EventSource[]> => {
  requireBuilder(by);
  requireNotStaff(by);
  const rows = await drizzle(env.DB)
    .select()
    .from(eventSources)
    .where(isNull(eventSources.deletedAt))
    .orderBy(asc(eventSources.createdAt), asc(eventSources.id))
    .all();
  const admin = isAdmin(by.role);
  return rows.map((row) => viewOf(row, admin));
};

/** Creates a source for an admin, its secret answered this once (`EventSourcesApi.create`). */
export const createEventSource = async (
  env: Env,
  by: Acting,
  input: unknown
): Promise<EventSourceWithSecret> => {
  requireSourceAdmin(by);
  const { name } = eventSourceErrors.parse(
    "webhook.source_invalid",
    eventSourceCreateSchema,
    input
  );
  const row: SourceRow = {
    id: crypto.randomUUID(),
    name,
    token: toHex(crypto.getRandomValues(new Uint8Array(tokenBytes))),
    secretGeneration: 1,
    secretRevokedAt: null,
    createdBy: by.userId,
    createdAt: new Date(),
    deletedAt: null,
  };
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db.insert(eventSources).values(row),
    outboxed(db, entry(by, "event_source.created", row.id, { name })),
  ]);
  return {
    source: viewOf(row, true),
    secret: await secretOf(env, row.id, row.secretGeneration),
  };
};

/**
 * Makes source `id` a new secret, for an admin: its generation one more,
 * so the old secret takes nothing from then on, and a revoked one is
 * replaced. The new secret is answered this once, audited as rotated,
 * never itself.
 */
export const rotateSourceSecret = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<EventSourceWithSecret> => {
  requireSourceAdmin(by);
  const source = await liveSource(env, id);
  if (source === undefined) {
    throw unavailable();
  }
  const db = drizzle(env.DB);
  const [[rotated]] = await auditedBatch(env, db, [
    db
      .update(eventSources)
      .set({
        secretGeneration: sql`${eventSources.secretGeneration} + 1`,
        secretRevokedAt: null,
      })
      .where(
        and(eq(eventSources.id, source.id), isNull(eventSources.deletedAt))
      )
      .returning(),
    outboxedIfChanged(db, entry(by, "event_source.secret_rotated", source.id)),
  ]);
  if (rotated === undefined) {
    throw unavailable();
  }
  return {
    source: viewOf(rotated, true),
    secret: await secretOf(env, rotated.id, rotated.secretGeneration),
  };
};

/**
 * Revokes source `id`'s secret, for an admin: it takes no delivery until
 * one makes a new one. Audited only when it had one.
 */
export const revokeSourceSecret = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<EventSource> => {
  requireSourceAdmin(by);
  const source = await liveSource(env, id);
  if (source === undefined) {
    throw unavailable();
  }
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(eventSources)
      .set({ secretRevokedAt: new Date() })
      .where(
        and(
          eq(eventSources.id, source.id),
          isNull(eventSources.deletedAt),
          isNull(eventSources.secretRevokedAt)
        )
      ),
    outboxedIfChanged(db, entry(by, "event_source.secret_revoked", source.id)),
  ]);
  const revoked = await liveSource(env, source.id);
  if (revoked === undefined) {
    throw unavailable();
  }
  return viewOf(revoked, true);
};

/**
 * Deletes source `id`, for an admin: its token goes, so its URL answers as
 * one nobody has, and no trigger on it starts anything more (each start
 * reads the source live as it is admitted). Audited.
 */
export const deleteEventSource = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<void> => {
  requireSourceAdmin(by);
  const source = await liveSource(env, id);
  if (source === undefined) {
    throw unavailable();
  }
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(eventSources)
      .set({ deletedAt: new Date(), token: null })
      .where(
        and(eq(eventSources.id, source.id), isNull(eventSources.deletedAt))
      ),
    outboxedIfChanged(db, entry(by, "event_source.deleted", source.id)),
  ]);
};
