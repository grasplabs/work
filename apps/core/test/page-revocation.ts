import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, onTestFinished, vi } from "vite-plus/test";
import { z } from "zod";

import { retryAccessRevocations } from "../src/access-revocations.ts";
import { appHost } from "../src/durable-objects.ts";
import { sessionRecheckMs } from "../src/session-check.ts";
import { apiOf } from "./notes-client-app.ts";
import type { Opened, Pages } from "./page-client.ts";
import {
  clientFor,
  eventually,
  requestOf,
  storeObjectOf,
  pageFollower,
  titlesOf,
} from "./page-client.ts";

// Revocation's tests' helpers (page-client-revocation*.test.ts): how a
// page is followed and let go of, and the databases, hosts and clocks
// that fail or wait on cue.

/**
 * How long a page may take to be cleared once access is gone: shorter
 * than the window a connection's session reading holds, so what clears it
 * is the event, never that reading running out.
 */
export const deliveryWait = { timeout: sessionRecheckMs - 1000, interval: 50 };

/** A raw subscription to the notes list over `pages`, once its first result arrived. */
export const followedList = async (
  opened: Opened,
  pages: Pages,
  lease: string
) => {
  const follower = pageFollower();
  await pages
    .frame(opened.app, lease)
    .watchQuery(
      requestOf(apiOf(opened.release).list, { pagination: {} }),
      follower.callback
    );
  await eventually(() => {
    expect(follower.received.at(-1)?.result.ok).toBeTruthy();
  });
  return follower;
};

export type Follower = Awaited<ReturnType<typeof followedList>>;

/** Statements that read whom an App is shared with. */
export const sharedWithQueries = /from "app_members"/u;

/** The look at an App by its ID (apps.ts `findApp`). */
export const appLookup = /^select "id", "name", "description"/u;

/**
 * Core's database for a connection of its own, which fails the
 * statements `failing` matches once `fail` is called, as D1 does when it
 * is away for a moment.
 */
export const flakyDb = (failing: RegExp) => {
  const state = { failing: false };
  const db = new Proxy(env.DB, {
    get: (target, property): unknown => {
      if (property === "prepare") {
        return (query: string) => {
          if (state.failing && failing.test(query)) {
            throw new Error("D1 is away for a moment.");
          }
          return target.prepare(query);
        };
      }
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") {
        return value;
      }
      const bound: unknown = value.bind(target);
      return bound;
    },
  });
  return {
    env: { ...env, DB: db },
    fail: () => {
      state.failing = true;
    },
  };
};

/** Fails as D1 does while it is away. */
export const refuse = (): never => {
  throw new Error("D1 is away.");
};

/**
 * Core's database for a connection of its own that goes away right after
 * the first batch it commits, as D1 can: every statement after it fails.
 */
export const awayAfterTheChange = (): D1Database => {
  const state = { away: false };
  return new Proxy(env.DB, {
    get: (target, property): unknown => {
      if (property === "prepare") {
        return (query: string) =>
          state.away ? refuse() : target.prepare(query);
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (state.away) {
            refuse();
          }
          const results = await target.batch(statements);
          state.away = true;
          return results;
        };
      }
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") {
        return value;
      }
      const bound: unknown = value.bind(target);
      return bound;
    },
  });
};

/**
 * Core's database for a connection of its own on which `userId` is made
 * an admin just before its first batch, as a promotion landing between a
 * change's reads and its batch would.
 */
export const promotedBeforeTheChange = (userId: string): D1Database => {
  const state = { promoted: false };
  return new Proxy(env.DB, {
    get: (target, property): unknown => {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!state.promoted) {
            state.promoted = true;
            await target
              .prepare("update members set role = 'admin' where user_id = ?")
              .bind(userId)
              .run();
          }
          return await target.batch(statements);
        };
      }
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") {
        return value;
      }
      const bound: unknown = value.bind(target);
      return bound;
    },
  });
};

/**
 * The App hosts' namespace as a connection that can't reach them to tell
 * of a revocation sees it: every `accessRevoked` fails, anything else
 * goes through.
 */
export const unreachableRevocations = (namespace: Env["APPS"]): Env["APPS"] =>
  new Proxy(namespace, {
    get: (target, property): unknown => {
      if (property === "getByName") {
        return (name: string) =>
          new Proxy(target.getByName(name), {
            get: (stub, method): unknown => {
              if (method === "accessRevoked") {
                return async () => {
                  await Promise.resolve();
                  throw new Error("The App's host can't be reached.");
                };
              }
              const value: unknown = Reflect.get(stub, method);
              if (typeof value !== "function") {
                return value;
              }
              // A stub's method answers any property as another method,
              // `bind` included: called through, never bound.
              return (...args: unknown[]): unknown =>
                Reflect.apply(value, stub, args);
            },
          });
      }
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") {
        return value;
      }
      const bound: unknown = value.bind(target);
      return bound;
    },
  });

/**
 * Adds `count` Apps owned by `ownerId`, with nothing in them, at once, each
 * ID after `prefix`; once the test finishes, removes them, with their rows,
 * and every revocation of `people`, every-App or of an App made earlier in
 * the file, so no later test's clock runs expand or retry them, and
 * nothing of any other test's.
 */
export const manyApps = async (
  ownerId: string,
  count: number,
  people: readonly string[],
  prefix = ""
): Promise<void> => {
  const ids = JSON.stringify(
    Array.from({ length: count }, () => `${prefix}${crypto.randomUUID()}`)
  );
  await env.DB.prepare(
    "insert into apps (id, name, description, owner_id, created_at) select value, 'Many', '', ?, ? from json_each(?)"
  )
    .bind(ownerId, Date.now(), ids)
    .run();
  onTestFinished(async () => {
    await env.DB.batch([
      env.DB.prepare(
        "delete from apps where id in (select value from json_each(?))"
      ).bind(ids),
      env.DB.prepare(
        "delete from access_revocations where user_ids in (select value from json_each(?))"
      ).bind(JSON.stringify(people.map((userId) => JSON.stringify([userId])))),
    ]);
  });
};

/** Every revocation kept for `userId` alone. */
export const keptForPerson = async (userId: string) => {
  const { results } = await env.DB.prepare(
    "select app_id as appId, user_ids as userIds, after_app_id as afterAppId from access_revocations where user_ids = ?"
  )
    .bind(JSON.stringify([userId]))
    .all();
  return results;
};

/** How many every-App and per-App revocations are kept for `userId` alone. */
export const everyAppKeptFor = async (userId: string) =>
  await env.DB.prepare(
    "select count(*) - count(app_id) as everyApp, count(app_id) as apps from access_revocations where user_ids = ?"
  )
    .bind(JSON.stringify([userId]))
    .first<{ everyApp: number; apps: number }>();

/** `userId`'s role in the organization, if they are a member. */
export const organizationRoleOf = async (userId: string) =>
  await env.DB.prepare("select role from members where user_id = ?")
    .bind(userId)
    .first<string>("role");

/**
 * The App hosts' namespace as a connection sees it that tells only
 * `app`'s host of a revocation: every other `accessRevoked` is taken at
 * once, without waking the host, and counted in `told`.
 */
export const quickRevocations = (
  namespace: Env["APPS"],
  app: string,
  told: { others: number }
): Env["APPS"] =>
  new Proxy(namespace, {
    get: (target, property): unknown => {
      if (property === "getByName") {
        return (name: string) => {
          const stub = target.getByName(name);
          if (name === app) {
            return stub;
          }
          return new Proxy(stub, {
            get: (inner, method): unknown => {
              if (method === "accessRevoked") {
                return async () => {
                  await Promise.resolve();
                  told.others += 1;
                };
              }
              const value: unknown = Reflect.get(inner, method);
              if (typeof value !== "function") {
                return value;
              }
              // A stub's method answers any property as another method,
              // `bind` included: called through, never bound.
              return (...args: unknown[]): unknown =>
                Reflect.apply(value, inner, args);
            },
          });
        };
      }
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") {
        return value;
      }
      const bound: unknown = value.bind(target);
      return bound;
    },
  });

/**
 * The clock's revocation step alone (`retryAccessRevocations`), on an env
 * with `changes`: the rest of the clock touches many objects, and these
 * tests run it often.
 */
export const revocationsClock = async (
  changes: Partial<Env>
): Promise<void> => {
  await retryAccessRevocations({ ...env, ...changes });
};

/** A cleared page: its last push a refusal, and core let go of it. */
export const refusedAndLetGo = { last: "app.not_found", released: true };

/**
 * What `follower` was last sent once core let go of it, which it must
 * within `deliveryWait`.
 */
export const whenLetGo = async (follower: Follower) => {
  await vi.waitFor(() => {
    expect(follower.state.released).toBeTruthy();
  }, deliveryWait);
  return {
    last: titlesOf(follower.received.at(-1)),
    released: follower.state.released,
  };
};

/** How long `slowToFollow` holds each connection the App's host takes on. */
export const followDelayMs = 2000;

/** Undoes nothing. */
export const nothingToUndo = (): void => {
  // Nothing done yet.
};

/**
 * Has the opened App's host take each connection on as followers of its
 * revocations only `followDelayMs` late, as a busy host would. Answers
 * how to undo it.
 */
export const slowToFollow = async (opened: Opened) => {
  let undo = nothingToUndo;
  await runInDurableObject(appHost(env, opened.app), (instance) => {
    // SAFETY: an App's object's prototype holds its methods.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const methods = Object.getPrototypeOf(instance) as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const original = methods.followAccess;
    if (original === undefined) {
      throw new Error("An App's object follows access");
    }
    methods.followAccess = async function followAccess(this: unknown, ...args) {
      await scheduler.wait(followDelayMs);
      return await original.apply(this, args);
    };
    undo = () => {
      methods.followAccess = original;
    };
  });
  return undo;
};

/**
 * Has the opened App's host let go of the first connection it takes on
 * as a follower of its revocations right away, as a host that restarted
 * would, and take the next one on only `followDelayMs` late. Answers how
 * to undo it.
 */
export const lettingGoEarly = async (opened: Opened) => {
  let undo = nothingToUndo;
  await runInDurableObject(appHost(env, opened.app), (instance) => {
    // SAFETY: an App's object's prototype holds its methods.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const methods = Object.getPrototypeOf(instance) as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const original = methods.followAccess;
    const letGo = methods.unfollowAccess;
    if (original === undefined || letGo === undefined) {
      throw new Error("An App's object follows access");
    }
    let calls = 0;
    methods.followAccess = async function followAccess(this: unknown, ...args) {
      calls += 1;
      if (calls > 1) {
        await scheduler.wait(followDelayMs);
        return await original.apply(this, args);
      }
      const id = await original.apply(this, args);
      await Reflect.apply(letGo, this, [id]);
      return id;
    };
    undo = () => {
      methods.followAccess = original;
    };
  });
  return undo;
};

/**
 * Counts the opened App's store's reads of a page of `pageSize` records
 * from now on, holding the first until `release`.
 */
export const holdPageReads = async (opened: Opened, pageSize: number) => {
  const storeId = opened.release.store?.storeId;
  const counted = { reads: 0 };
  const held = Promise.withResolvers<null>();
  let undo = nothingToUndo;
  const pageOfSize = z.object({
    kind: z.literal("query"),
    query: z.object({
      terminal: z.object({
        kind: z.literal("paginate"),
        pageSize: z.literal(pageSize),
      }),
    }),
  });
  await runInDurableObject(storeObjectOf(opened), (instance) => {
    // SAFETY: a store's object's prototype holds its methods.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const methods = Object.getPrototypeOf(instance) as {
      read: (...args: unknown[]) => Promise<string>;
    };
    const original: unknown = Reflect.get(methods, "read");
    if (typeof original !== "function") {
      throw new TypeError("A store's object reads");
    }
    methods.read = async function read(
      this: unknown,
      ...args: unknown[]
    ): Promise<string> {
      if (args[0] === storeId && pageOfSize.safeParse(args[2]).success) {
        counted.reads += 1;
        if (counted.reads === 1) {
          await held.promise;
        }
      }
      const answer: unknown = await Reflect.apply(original, this, args);
      return String(answer);
    };
    undo = () => {
      Reflect.set(methods, "read", original);
    };
  });
  return {
    count: () => counted.reads,
    release: () => {
      held.resolve(null);
    },
    restore: () => {
      held.resolve(null);
      undo();
    },
  };
};

/** What reaches `follower` once someone commits to what it read. */
export const afterACommit = async (opened: Opened, follower: Follower) => {
  const before = follower.received.length;
  await clientFor(opened).client.mutation(apiOf(opened.release).create, {
    title: "Committed after",
  });
  await scheduler.wait(1500);
  return follower.received.slice(before);
};
