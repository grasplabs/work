import { actorOf } from "@grasp-os/shared/audit";
import type { Identity } from "@grasp-os/shared/rpc";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxed } from "./audit-outbox.ts";
import { currentCall } from "./call-context.ts";
import type { SessionCheck } from "./session-check.ts";

// Every view and action of Grasp's staff on a client's deployment is in
// the client's audit log (GRA-1087; its threat model): staff may read
// everything, and the client sees each time they do, as "(Grasp staff)".
//
// One entry per view, written where every call already passes:
// - over `/rpc`, each target's methods are wrapped when it is constructed
//   (rpc-target.ts, `CoreRpcTarget`), which notes the call it is running
//   (call-context.ts); the session check every method asks for the person
//   (`staffAudited`, wrapped once around the connection's check in
//   session-rpc.ts) writes the entry when the person is staff, before the
//   method goes on;
// - a route that identifies the person itself writes it there
//   (`auditStaffRoute`).
//
// An entry names what was viewed, never what it holds: the surface
// (namespace and method, or route), how many arguments it took, and the
// identifiers among them, which only strings of an identifier's shape
// count as, so a search's terms or a document's text never do. It is
// stored in core's outbox before the call goes on: one that can't be
// stored fails the call, so no view goes unrecorded. The same view
// (surface and identifiers) on one connection is written once per
// `repeatWindowMs`, so a page asking again and again doesn't flood the
// log; anything else is always an entry of its own.

/** How long one connection's same view is one entry. */
export const repeatWindowMs = 5 * 60_000;

/** The most identifiers one entry names. */
const idsPerEntry = 20;

/** A UUID, or a prefixed ID (`ent_…`): an identifier's shape, never text. */
const idShape =
  /^(?:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}|[a-z][a-z\d]{1,15}_[\w-]{6,64})$/iu;

/** A target's name as a surface's: `KnowledgeRpc` is `knowledge`. */
const namespaceOf = (target: object): string => {
  const name = target.constructor.name.replace(/Rpc$/u, "");
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
};

/**
 * The identifiers among `values`, and one level into each object or list
 * they are: strings of an identifier's shape only.
 */
export const idsOf = (values: readonly unknown[]): string[] => {
  const found = new Set<string>();
  const take = (value: unknown): void => {
    if (typeof value === "string" && idShape.test(value)) {
      found.add(value);
    }
  };
  for (const value of values) {
    take(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        take(item);
      }
    } else if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value)) {
        take(item);
      }
    }
  }
  return [...found].toSorted().slice(0, idsPerEntry);
};

/** What a staff member viewed or did: where, and of what. */
export interface StaffView {
  /** `namespace.method`, or a route's name. */
  surface: string;
  ids: readonly string[];
  /** How many arguments the call took. */
  args: number;
}

/**
 * Writes `view` by `person`, staff, to the client's audit log: in core's
 * outbox, drained at once; throws when it can't be stored, so the view
 * fails rather than go unrecorded.
 */
export const recordStaffView = async (
  env: Env,
  person: Pick<Identity, "userId" | "staff">,
  { surface, ids, args }: StaffView
): Promise<void> => {
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxed(db, {
      actor: actorOf(person),
      action: "staff.accessed",
      provenance: [...ids],
      detail: { surface, args, ids: ids.length },
    }),
  ]);
};

/**
 * `check`, writing an entry for each view of a staff member's: what the
 * call running now is (call-context.ts), once per `repeatWindowMs` for the same
 * view on this connection. A person who isn't staff writes none.
 */
export const staffAudited = (env: Env, check: SessionCheck): SessionCheck => {
  const written = new Map<string, number>();
  return Object.assign(
    async (): Promise<Identity> => {
      const person = await check();
      if (!person.staff) {
        return person;
      }
      const call = currentCall();
      const view: StaffView =
        call === undefined
          ? { surface: "session", ids: [], args: 0 }
          : {
              surface: `${namespaceOf(call.target)}.${call.method}`,
              ids: idsOf(call.args),
              args: call.args.length,
            };
      const key = `${view.surface}\u0000${view.ids.join(",")}`;
      const now = Date.now();
      const last = written.get(key);
      if (last === undefined || now - last >= repeatWindowMs) {
        await recordStaffView(env, person, view);
        written.set(key, now);
      }
      return person;
    },
    {
      forget: (): void => {
        check.forget?.();
      },
    }
  );
};

/**
 * Writes the entry of a route's view by `person`, if staff: `route` names
 * it, `ids` what it served.
 */
export const auditStaffRoute = async (
  env: Env,
  person: Pick<Identity, "userId" | "staff">,
  route: string,
  ids: readonly string[]
): Promise<void> => {
  if (person.staff) {
    await recordStaffView(env, person, {
      surface: route,
      ids: idsOf(ids),
      args: ids.length,
    });
  }
};
