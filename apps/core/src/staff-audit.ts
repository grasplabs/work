import { actorOf } from "@grasp-os/shared/audit";
import type { Identity } from "@grasp-os/shared/rpc";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxed } from "./audit-outbox.ts";
import { currentCall } from "./call-context.ts";
import { reachesWorkspace } from "./session-check.ts";
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
// (namespace and method, or route), how many arguments it took, the kind
// of each, by the name the method gives it (`query`, `input`), and the
// platform IDs (UUIDs, bare or after one of our short prefixes, as
// `ent_<uuid>`) held by parameters named as resource IDs (`documentId`,
// `app`). So a search's terms, a name or a secret never reach the log,
// whatever their shape: a query that looks like a UUID is still a query. It is stored in
// core's outbox before the call goes on: one that can't be stored fails
// the call, so no view goes unrecorded. The same view on one connection
// (surface, the target it was asked of, and a hash of all its arguments)
// is written once per
// `repeatWindowMs`, so a page asking again and again doesn't flood the
// log; a view of anything else, or the same surface asked something else,
// is always an entry of its own. A check outside any call (a push of a
// live query, a timer) is the call it was started in, which the call
// context carries on, so each subscription keeps a key of its own.
//
// The onboarding's methods take the roster's people by ID, which would
// tell the company who was interviewed (`kindsOnly`): its entries name the
// kinds of their arguments alone, never an ID, written before anything of
// the look, as every entry is.

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
 * Whether `surface`'s IDs could name an interviewee (see the header): the
 * onboarding's methods take the roster's people by ID (a look, a new
 * start, a reminder, a deletion), so none of the onboarding's entries name
 * an ID, only kinds.
 */
const kindsOnly = (surface: string): boolean =>
  surface.startsWith("onboarding");

/** The most views one connection remembers, for telling repeats apart. */
const rememberedMax = 1000;

/** Each target's own key: two Apps' frames are never one view. */
const targetKeys = new WeakMap<object, string>();

/** `target`'s own key, made the first time it is asked. */
const targetKeyOf = (target: object): string => {
  const known = targetKeys.get(target);
  if (known !== undefined) {
    return known;
  }
  const made = crypto.randomUUID();
  targetKeys.set(target, made);
  return made;
};

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

/** A parameter or member named as a resource's ID: `documentId`, `ids`. */
const idName = /^ids?$|I(?:d|ds)$/u;

/**
 * Parameters our methods name after the resource whose ID they take,
 * without saying `Id` (`apps.get(app)`, `workflows.status(run)`).
 */
const resourceNames: ReadonlySet<string> = new Set([
  "app",
  "blueprint",
  "chat",
  "collection",
  "connection",
  "decision",
  "document",
  "run",
  "store",
  "team",
  "trigger",
  "upload",
  "work",
  "workflow",
]);

/** Whether a parameter or member called `name` holds a resource's ID. */
const namesAnId = (name: string): boolean =>
  idName.test(name) || resourceNames.has(name);

/**
 * What `args`, named `names`, name: every argument by its kind, its
 * parameter's name (`query`, `input`), never an object's keys; and each
 * platform ID a parameter named as an ID holds (`documentId`, `app`), or an
 * object's member named so holds. A query, a text, a path or anything else
 * is its kind alone, whatever it looks like: a search for a UUID names no
 * ID.
 */
export const namedBy = (
  args: readonly unknown[],
  names: readonly string[]
): Named => {
  const ids = new Set<string>();
  const kinds = new Set<string>();
  const take = (value: unknown, kind: string, isId: boolean): void => {
    if (value === undefined || value === null) {
      return;
    }
    kinds.add(kind);
    if (isId && typeof value === "string" && platformId.test(value)) {
      ids.add(value);
    }
  };
  for (const [index, value] of args.entries()) {
    const name = names[index] ?? `arg${index}`;
    if (Array.isArray(value)) {
      for (const item of value) {
        take(item, name, namesAnId(name));
      }
    } else if (typeof value === "object" && value !== null) {
      // An object's keys may be anything its sender chose (a record's): it
      // is named by its parameter alone, with the IDs of its members named
      // as IDs; its keys are never written.
      for (const [key, item] of Object.entries(value)) {
        take(item, name, namesAnId(key));
      }
    } else {
      take(value, name, namesAnId(name));
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
  /** When each view was last written, oldest first. */
  const written = new Map<string, number>();
  /** The writes under way, by view: a repeat meanwhile waits for its own. */
  const writing = new Map<string, Promise<void>>();
  /** Forgets views past the window, and the oldest past `rememberedMax`. */
  const prune = (now: number): void => {
    for (const [key, at] of written) {
      if (now - at < repeatWindowMs && written.size <= rememberedMax) {
        break;
      }
      written.delete(key);
    }
  };
  /** Writes `view` once for `key`, however many ask at once. */
  const writeOnce = async (
    key: string,
    write: () => Promise<void>
  ): Promise<void> => {
    const under = writing.get(key);
    if (under !== undefined) {
      await under;
      return;
    }
    const now = Date.now();
    const last = written.get(key);
    if (last !== undefined && now - last < repeatWindowMs) {
      return;
    }
    const pending = write();
    writing.set(key, pending);
    try {
      await pending;
      written.delete(key);
      written.set(key, now);
      prune(now);
    } finally {
      writing.delete(key);
    }
  };
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
      // The target too: the same method of two Apps' frames is two views.
      const target = call === undefined ? "" : targetKeyOf(call.target);
      const key = `${surface}\u0000${target}\u0000${await argsHash(args)}`;
      await writeOnce(key, async () => {
        const named = namedBy(args, call?.params ?? []);
        await recordStaffView(env, person, {
          surface,
          args: args.length,
          kinds: named.kinds,
          ids: kindsOnly(surface) ? [] : named.ids,
        });
      });
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

/**
 * `person` (as `identify` read them) for a route outside the onboarding,
 * once their ask of `route` is in the audit log if they are staff
 * (`auditStaffRoute`): then `undefined` for staff, who reach no such route
 * (session-check.ts `reachesWorkspace`), as for nobody signed in. A staff
 * attempt is on record even though it is refused, as a refused call over
 * `/rpc` is (`staffAudited` runs before `fullAccess`).
 */
export const routeMember = async (
  env: Env,
  person: Identity | undefined,
  route: string,
  parts: Readonly<Record<string, unknown>> = {}
): Promise<Identity | undefined> => {
  if (person === undefined) {
    return undefined;
  }
  await auditStaffRoute(env, person, route, parts);
  return reachesWorkspace(person) ? person : undefined;
};
