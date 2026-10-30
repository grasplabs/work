import type { AuditEvent } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { drizzle } from "drizzle-orm/d1";

import { drainAuditOutboxes, uuidFromHash } from "./audit-outbox.ts";
import { eventsStopNoticed } from "./notifications.ts";
import { listenersOf } from "./workflows/connector-events.ts";

// Telling people that connect stopped hearing a source their triggers
// listen to: a mailbox or drive whose provider refused access, or whose
// reads kept failing. Connect records it once, as it stops
// (`connection.events.refused` or `connection.events.failed`, connect's
// events.ts), and can't reach core; its audit events reach core as the
// clock drains connect's outbox, and that is where this tells the owners
// of the triggers listening there, as core lists them for connect
// (`listenersOf`: the owners of Apps with an event trigger there, and of
// independent connector triggers). What could go wrong, and what stops it:
//
// - Told twice, or never: a drain cut short hands the same events over
//   again, and each notice's ID comes from the event's and the person's,
//   so it is written once. Written before the events leave the outbox, so
//   a drain that stops first writes it the next time.
// - Telling someone of a source that isn't theirs: only owners of
//   triggers that listen at that very connection, type and part are told,
//   and on a personal connection only its owner listens. Each is told only
//   while they are a member.
// - An event forged by someone else: only connect's own outbox is read
//   here, and only these two actions.
// - A notice that fails holding up the audit log: it is logged, and the
//   events go on into the log (audit-outbox.ts).

/** Connect's actions that say it stopped hearing a source, and why. */
const stopReasons: Readonly<Record<string, "refused" | "failed">> = {
  "connection.events.refused": "refused",
  "connection.events.failed": "failed",
};

/** A source connect stopped hearing, as its audit event says. */
interface Stop {
  eventId: string;
  at: Date;
  connection: string;
  type: string;
  resource: string | null;
  reason: "refused" | "failed";
}

/** The stop `event` records, if it records one. */
const stopOf = (event: AuditEvent): Stop | undefined => {
  const reason = Object.hasOwn(stopReasons, event.action)
    ? stopReasons[event.action]
    : undefined;
  const { type, resource } = event.detail ?? {};
  if (
    reason === undefined ||
    event.source !== "connect" ||
    event.target?.type !== "connection" ||
    typeof type !== "string"
  ) {
    return undefined;
  }
  return {
    eventId: event.id,
    at: new Date(event.at),
    connection: event.target.id,
    type,
    resource: typeof resource === "string" ? resource : null,
    reason,
  };
};

/**
 * Tells the owners of the triggers listening where `events` say connect
 * stopped hearing events: one notice each per stop, however often the
 * events are handed over.
 */
export const noticeStoppedSources = async (
  env: Env,
  events: readonly AuditEvent[]
): Promise<void> => {
  const stops = events.flatMap((event) => stopOf(event) ?? []);
  if (stops.length === 0) {
    return;
  }
  const listeners = await listenersOf(env);
  const notices = await Promise.all(
    stops.flatMap((stop) =>
      [
        ...new Set(
          listeners
            .filter(
              (listener) =>
                listener.connection === stop.connection &&
                listener.type === stop.type &&
                listener.resource === stop.resource
            )
            .map(({ owner }) => owner)
        ),
      ].map(async (personId) => ({
        ...stop,
        personId,
        id: uuidFromHash(await sha256Hex(`${stop.eventId}:${personId}`)),
      }))
    )
  );
  const db = drizzle(env.DB);
  const [first, ...rest] = notices.map((notice) =>
    eventsStopNoticed(db, notice)
  );
  if (first !== undefined) {
    await db.batch([first, ...rest]);
  }
};

/** Drains every audit outbox, telling people of the sources connect stopped hearing. */
export const drainAuditOutboxesNoticing = async (env: Env): Promise<number> =>
  await drainAuditOutboxes(env, async (events) => {
    await noticeStoppedSources(env, events);
  });
