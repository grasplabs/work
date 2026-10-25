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
// (namespace and method, or route), how many arguments it took, the
// platform IDs among them (UUIDs, bare or after one of our short prefixes,
// as `ent_<uuid>`), and the kind of every other argument, by the name the
// method gives it (`query`, `input`). So a search's terms, a name or
// a secret never reach the log, whatever their shape. It is stored in
// core's outbox before the call goes on: one that can't be stored fails
// the call, so no view goes unrecorded. The same view on one connection
// (surface, and a hash of all its arguments) is written once per
// `repeatWindowMs`, so a page asking again and again doesn't flood the
// log; a view of anything else, or the same surface asked something else,
// is always an entry of its own. A check outside any call (a push of a
// live query, a timer) is the call it was started in, which the call
// context carries on, so each subscription keeps a key of its own.
//
// Two methods of the onboarding take a person's ID that would tell the
// company who was interviewed (`kindsOnly`): their entries name the kinds
// of their arguments alone, never an ID, written before anything of the
// look, as every entry is.

/** How long one connection's same view is one entry. */
export const repeatWindowMs = 5 * 60_000;

/** The most identifiers one entry names. */
const idsPerEntry = 20;

/** The most characters of kinds one entry names. */
const kindsMaxLength = 256;

/** A platform ID: a UUID, bare or after one of our short prefixes. */
const platformId =
  /^(?:[a-z]{2,8}_)?[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;

/**
 * The surfaces whose IDs would name an interviewee (see the header): their
 * entries name kinds alone.
 */
const kindsOnly: ReadonlySet<string> = new Set([
  "onboardingStaff.interview",
  "onboardingStaff.link",
]);

/**
 * A target's name as a surface's: `KnowledgeRpc` is `knowledge`. Read from
 * its class's name, which holds as core's bundle isn't minified.
 */
const namespaceOf = (target: object): string => {
  const name = target.constructor.name.replace(/Rpc$/u, "");
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
};

/** What a call's arguments name: platform IDs, and the kinds of the rest. */
export interface Named {
  ids: string[];
  kinds: string[];
}

/**
 * What `args`, named `names`, name: every argument by its kind, its
 * parameter's name (`query`, `input`), never an object's keys; and each
 * platform ID one is, or holds one level in (an object's members, a list's
 * items), by its value. Nothing else of what they hold.
 */
export const namedBy = (
  args: readonly unknown[],
  names: readonly string[]
): Named => {
  const ids = new Set<string>();
  const kinds = new Set<string>();
  const take = (value: unknown, kind: string): void => {
    if (value === undefined || value === null) {
      return;
    }
    kinds.add(kind);
    if (typeof value === "string" && platformId.test(value)) {
      ids.add(value);
    }
  };
  for (const [index, value] of args.entries()) {
    const name = names[index] ?? `arg${index}`;
    if (Array.isArray(value)) {
      for (const item of value) {
        take(item, name);
      }
    } else if (typeof value === "object" && value !== null) {
      // An object's keys may be anything its sender chose (a record's): it
      // is named by its parameter alone, with the IDs among its members.
      for (const item of Object.values(value)) {
        take(item, name);
      }
    } else {
      take(value, name);
    }
  }
  return {
    ids: [...ids].toSorted().slice(0, idsPerEntry),
    kinds: [...kinds].toSorted(),
  };
};

/** What a staff member viewed or did: where, and of what. */
export interface StaffView extends Named {
  /** `namespace.method`, or a route's name. */
  surface: string;
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
  { surface, ids, kinds, args }: StaffView
): Promise<void> => {
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxed(db, {
      actor: actorOf(person),
      action: "staff.accessed",
      provenance: [...ids],
      detail: {
        surface,
        args,
        ids: ids.length,
        kinds: kinds.join(",").slice(0, kindsMaxLength),
      },
    }),
  ]);
};

/**
 * A hash of `args`, for telling one view from another without keeping
 * what they hold; a value JSON can't take (a stub) makes every call its
 * own.
 */
const argsHash = async (args: readonly unknown[]): Promise<string> => {
  let text: string;
  try {
    text = JSON.stringify(args) ?? "";
  } catch {
    return crypto.randomUUID();
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * `check`, writing an entry for each view of a staff member's: what the
 * call running now is (call-context.ts), once per `repeatWindowMs` for the
 * same view on this connection. A person who isn't staff writes none.
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
      const surface =
        call === undefined
          ? "session"
          : `${namespaceOf(call.target)}.${call.method}`;
      const args = call?.args ?? [];
      const key = `${surface}\u0000${await argsHash(args)}`;
      const now = Date.now();
      const last = written.get(key);
      if (last === undefined || now - last >= repeatWindowMs) {
        const named = namedBy(args, call?.params ?? []);
        await recordStaffView(env, person, {
          surface,
          args: args.length,
          kinds: named.kinds,
          ids: kindsOnly.has(surface) ? [] : named.ids,
        });
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
 * it, `parts` what it was asked for, by name.
 */
export const auditStaffRoute = async (
  env: Env,
  person: Pick<Identity, "userId" | "staff">,
  route: string,
  parts: Readonly<Record<string, unknown>> = {}
): Promise<void> => {
  if (person.staff) {
    const names = Object.keys(parts);
    await recordStaffView(env, person, {
      surface: route,
      args: names.length,
      ...namedBy(Object.values(parts), names),
    });
  }
};
