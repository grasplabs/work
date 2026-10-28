import { GraspClient } from "@grasp-os/sdk/host";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { z } from "zod";

import { retryAccessRevocations } from "../src/access-revocations.ts";
import { appHost } from "../src/durable-objects.ts";
import { sessionRecheckMs } from "../src/session-check.ts";
import { requestGranted } from "./apps.ts";
import { newTeam, readCollection } from "./knowledge.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { apiOf, referenceTo } from "./notes-client-app.ts";
import type { Opened, Screens } from "./screen-client.ts";
import {
  mockSessionIdp,
  personApi,
  openedApp,
  pageTransport,
  clientFor,
  reading,
  eventually,
  shown,
  requestOf,
  storeObjectOf,
  pageFollower,
  titlesOf,
  memberOf,
  withSecrets,
} from "./screen-client.ts";
import { callAuth, openRpc, outcome, unique } from "./sign-in.ts";

// Revocation (spec 11.4): when a write takes a person's role in an App
// away, their open screens are cleared without waiting for anything to
// commit to what they read, on every tab, and nothing more reaches them;
// anyone whose access holds keeps their screen, whatever the event says.

const idp = mockSessionIdp();

/**
 * How long a screen may take to be cleared once access is gone: shorter
 * than the window a connection's session reading holds, so what clears it
 * is the event, never that reading running out.
 */
const deliveryWait = { timeout: sessionRecheckMs - 1000, interval: 50 };

/** A raw subscription to the notes list over `screens`, once its first result arrived. */
const followedList = async (
  opened: Opened,
  screens: Screens,
  lease: string
) => {
  const follower = pageFollower();
  await screens
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

type Follower = Awaited<ReturnType<typeof followedList>>;

/** Statements that read whom an App is shared with. */
const sharedWithQueries = /from "app_members"/u;

/** The look at an App by its ID (apps.ts `findApp`). */
const appLookup = /^select "id", "name", "description"/u;

/**
 * Core's database for a connection of its own, which fails the
 * statements `failing` matches once `fail` is called, as D1 does when it
 * is away for a moment.
 */
const flakyDb = (failing: RegExp) => {
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
const refuse = (): never => {
  throw new Error("D1 is away.");
};

/**
 * Core's database for a connection of its own that goes away right after
 * the first batch it commits, as D1 can: every statement after it fails.
 */
const awayAfterTheChange = (): D1Database => {
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
const promotedBeforeTheChange = (userId: string): D1Database => {
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
const unreachableRevocations = (namespace: Env["APPS"]): Env["APPS"] =>
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
 * and the every-App revocations of `people`, so no later test's clock runs
 * expand them, and nothing of any other test's.
 */
const manyApps = async (
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
        "delete from access_revocations where app_id is null and user_ids in (select value from json_each(?))"
      ).bind(JSON.stringify(people.map((userId) => JSON.stringify([userId])))),
    ]);
  });
};

/** Every revocation kept for `userId` alone. */
const keptForPerson = async (userId: string) => {
  const { results } = await env.DB.prepare(
    "select app_id as appId, user_ids as userIds, after_app_id as afterAppId from access_revocations where user_ids = ?"
  )
    .bind(JSON.stringify([userId]))
    .all();
  return results;
};

/** How many every-App and per-App revocations are kept for `userId` alone. */
const everyAppKeptFor = async (userId: string) =>
  await env.DB.prepare(
    "select count(*) - count(app_id) as everyApp, count(app_id) as apps from access_revocations where user_ids = ?"
  )
    .bind(JSON.stringify([userId]))
    .first<{ everyApp: number; apps: number }>();

/** `userId`'s role in the organization, if they are a member. */
const organizationRoleOf = async (userId: string) =>
  await env.DB.prepare("select role from members where user_id = ?")
    .bind(userId)
    .first<string>("role");

/**
 * The App hosts' namespace as a connection sees it that tells only
 * `app`'s host of a revocation: every other `accessRevoked` is taken at
 * once, without waking the host, and counted in `told`.
 */
const quickRevocations = (
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
const revocationsClock = async (changes: Partial<Env>): Promise<void> => {
  await retryAccessRevocations({ ...env, ...changes });
};

/** A cleared screen: its last push a refusal, and core let go of it. */
const refusedAndLetGo = { last: "app.not_found", released: true };

/**
 * What `follower` was last sent once core let go of it, which it must
 * within `deliveryWait`.
 */
const whenLetGo = async (follower: Follower) => {
  await vi.waitFor(() => {
    expect(follower.state.released).toBeTruthy();
  }, deliveryWait);
  return {
    last: titlesOf(follower.received.at(-1)),
    released: follower.state.released,
  };
};

/** How long `slowToFollow` holds each connection the App's host takes on. */
const followDelayMs = 2000;

/** Undoes nothing. */
const nothingToUndo = (): void => {
  // Nothing done yet.
};

/**
 * Has the opened App's host take each connection on as followers of its
 * revocations only `followDelayMs` late, as a busy host would. Answers
 * how to undo it.
 */
const slowToFollow = async (opened: Opened) => {
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
const lettingGoEarly = async (opened: Opened) => {
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
const holdPageReads = async (opened: Opened, pageSize: number) => {
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
const afterACommit = async (opened: Opened, follower: Follower) => {
  const before = follower.received.length;
  await clientFor(opened).client.mutation(apiOf(opened.release).create, {
    title: "Committed after",
  });
  await scheduler.wait(1500);
  return follower.received.slice(before);
};

describe("live queries when access is revoked", { timeout: 180_000 }, () => {
  it("clears a screen as soon as the person is unshared, with no commit after, and sends nothing more", async () => {
    const opened = await openedApp();
    const { them, lease, member } = await memberOf(opened);
    const follower = await followedList(opened, member.api.screens, lease);

    await opened.builder.api.apps.members.remove(opened.app, them);

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
    await expect(afterACommit(opened, follower)).resolves.toStrictEqual([]);
  });

  it("clears the screen of someone who leaves the team the App is shared with", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const member = await personApi("user");
    const team = await newTeam(admin, [member]);
    await admin.api.apps.members.add(opened.app, {
      type: "team",
      id: team,
      role: "user",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    const follower = await followedList(opened, member.api.screens, lease);

    await callAuth("/organization/remove-team-member", admin.session, {
      teamId: team,
      userId: member.userId,
    });

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("clears the screen of someone whose team, the App's way to them, is deleted", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const member = await personApi("user");
    const team = await newTeam(admin, [member]);
    await admin.api.apps.members.add(opened.app, {
      type: "team",
      id: team,
      role: "user",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    const follower = await followedList(opened, member.api.screens, lease);
    // The organization keeps a team: this one is never its last.
    await newTeam(admin, []);

    const removed = await callAuth("/organization/remove-team", admin.session, {
      teamId: team,
    });
    expect(removed.status).toBe(200);

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("clears the screen of someone the App was shared with directly, once leaving a team leaves them unable to read what it read", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const member = await personApi("user");
    const team = await newTeam(admin, [member]);
    const { id: collection } = await admin.api.knowledge.createCollection({
      name: `HR ${unique()}`,
      access: "teams",
      teams: [team],
      sensitive: false,
    });
    await requestGranted(
      idp,
      opened.builder,
      readCollection(
        { type: "app", appId: opened.app },
        collection,
        `HR_${unique().toUpperCase()}`
      )
    );
    // Shared with them as a person, never with the team.
    await opened.builder.api.apps.members.add(opened.app, {
      type: "person",
      id: member.userId,
      role: "user",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    const follower = await followedList(opened, member.api.screens, lease);

    await callAuth("/organization/remove-team-member", admin.session, {
      teamId: team,
      userId: member.userId,
    });

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("clears an admin's screen once they are demoted out of the App, on a session read just before", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const demoted = await personApi("admin");
    const { lease } = await demoted.api.screens.open(opened.app, "notes");
    const follower = await followedList(opened, demoted.api.screens, lease);

    await admin.api.members.setRole(demoted.userId, "user");

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("keeps the screens of everyone whose access holds, when others of the App lose theirs", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const leaving = await personApi("user");
    const team = await newTeam(admin, [leaving]);
    const unshared = { type: "team", id: team } as const;
    await admin.api.apps.members.add(opened.app, { ...unshared, role: "user" });
    const { lease } = await leaving.api.screens.open(opened.app, "notes");
    const theirs = await followedList(opened, leaving.api.screens, lease);
    const staying = await memberOf(opened);
    const kept = await followedList(
      opened,
      staying.member.api.screens,
      staying.lease
    );

    // Everyone the App's host knows of looks again.
    await admin.api.apps.members.remove(opened.app, unshared);
    await expect(whenLetGo(theirs)).resolves.toStrictEqual(refusedAndLetGo);
    await staying.client.mutation(apiOf(opened.release).create, {
      title: "Still mine",
    });

    await eventually(() => {
      expect(titlesOf(kept.received.at(-1))).toStrictEqual(["Still mine"]);
    });
    expect({
      released: kept.state.released,
      refused: kept.received.some(({ result }) => !result.ok),
    }).toStrictEqual({ released: false, refused: false });
  });

  it("changes nothing for someone whose access holds, whoever says it was revoked", async () => {
    const opened = await openedApp();
    const { lease, member, client } = await memberOf(opened);
    const follower = await followedList(opened, member.api.screens, lease);

    await appHost(env, opened.app).accessRevoked([member.userId]);
    await appHost(env, opened.app).accessRevoked(null);
    await scheduler.wait(1500);
    await client.mutation(apiOf(opened.release).create, { title: "Mine" });

    await eventually(() => {
      expect(titlesOf(follower.received.at(-1))).toStrictEqual(["Mine"]);
    });
    expect({
      released: follower.state.released,
      refused: follower.received.some(({ result }) => !result.ok),
    }).toStrictEqual({ released: false, refused: false });
  });

  it("clears every tab of the person, each on its own connection", async () => {
    const opened = await openedApp();
    const { them, lease, member } = await memberOf(opened);
    const { core } = await openRpc(member.session);
    const otherTab = core.authenticate().screens;
    const first = await followedList(opened, member.api.screens, lease);
    const second = await followedList(opened, otherTab, lease);

    await opened.builder.api.apps.members.remove(opened.app, them);

    await expect(whenLetGo(first)).resolves.toStrictEqual(refusedAndLetGo);
    await expect(whenLetGo(second)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("clears what a frame of the tab follows through its own handle", async () => {
    const opened = await openedApp();
    const { them, lease, member } = await memberOf(opened);
    const frame = await member.api.screens.frame(opened.app, lease);
    const follower = pageFollower();
    await frame.watchQuery(
      requestOf(apiOf(opened.release).list, { pagination: {} }),
      follower.callback
    );
    await eventually(() => {
      expect(follower.received.at(-1)?.result.ok).toBeTruthy();
    });

    await opened.builder.api.apps.members.remove(opened.app, them);

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("never shows a query followed right after the revocation, on a session read before it", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const demoted = await personApi("admin");
    const { lease } = await demoted.api.screens.open(opened.app, "notes");
    // A tab that reads the session now, with the App's frame open, and
    // follows nothing of the App yet.
    const { core } = await openRpc(demoted.session);
    const frame = await core.authenticate().screens.frame(opened.app, lease);

    await admin.api.members.setRole(demoted.userId, "user");
    // The App's host is slow to take the tab on: the event went out
    // before, and the tab's reads must wait for it either way.
    const undo = await slowToFollow(opened);
    try {
      const follower = pageFollower();
      await frame.watchQuery(
        requestOf(apiOf(opened.release).list, { pagination: {} }),
        follower.callback
      );

      await vi.waitFor(
        () => {
          expect(follower.state.released).toBeTruthy();
        },
        { ...deliveryWait, timeout: deliveryWait.timeout + followDelayMs }
      );
      expect(follower.received.map(({ result }) => result.ok)).toStrictEqual([
        false,
      ]);
    } finally {
      undo();
    }
  });

  it("follows again once the App's host restarted, so a revocation after still clears the screen", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const demoted = await personApi("admin");
    const { lease } = await demoted.api.screens.open(opened.app, "notes");
    const follower = await followedList(opened, demoted.api.screens, lease);
    await runInDurableObject(appHost(env, opened.app), (_app, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });
    // Once the connection follows the new host: the event below must reach
    // it there. (Telling it, while its access holds, changes nothing.)
    await vi.waitFor(
      async () => {
        await expect(
          appHost(env, opened.app).accessRevoked([demoted.userId])
        ).resolves.toBeGreaterThan(0);
      },
      { timeout: 10_000, interval: 100 }
    );

    // A demotion tells the host and restarts nothing.
    await admin.api.members.setRole(demoted.userId, "user");

    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("clears the screen of someone removed from the organization", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const { lease, member } = await memberOf(opened);
    const follower = await followedList(opened, member.api.screens, lease);

    await admin.api.members.remove(member.userId);

    await expect(whenLetGo(follower)).resolves.toStrictEqual({
      last: "auth.unauthenticated",
      released: true,
    });
  });

  it("clears what a query kept while it waits to follow again, once the person is only a user", async () => {
    const opened = await openedApp(withSecrets());
    const tell = referenceTo<{ text: string }, unknown, "mutation">(
      opened.release,
      "notes.tell"
    );
    const secrets = referenceTo<Record<never, never>, unknown, "query">(
      opened.release,
      "notes.secrets"
    );
    await clientFor(opened).client.mutation(tell, { text: "Builders only" });
    const member = await personApi("builder");
    const them = { type: "person", id: member.userId } as const;
    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "builder",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    const page = pageTransport(
      { ...opened, lease, cookie: member.session, userId: member.userId },
      member.api.screens
    );
    const isSecrets = (request: string): boolean =>
      z
        .object({ reference: z.object({ contractId: z.string() }) })
        .parse(JSON.parse(request)).reference.contractId === secrets.contractId;
    // The secrets are followed once, then lost after their first push, and
    // followed again only once the test is over: meanwhile the query
    // waits to follow again, showing what it kept.
    const held = Promise.withResolvers<null>();
    let secretsFollows = 0;
    const client = new GraspClient({
      call: page.call,
      watch: async (request, onSnapshot, onLost) => {
        if (!isSecrets(request)) {
          return await page.watch(request, onSnapshot, onLost);
        }
        secretsFollows += 1;
        if (secretsFollows > 1) {
          await held.promise;
          return await page.watch(request, onSnapshot, onLost);
        }
        const handle: { release: (() => void) | undefined } = {
          release: undefined,
        };
        let pushed = false;
        const followed = await page.watch(
          request,
          (push) => {
            onSnapshot(push);
            if (!pushed) {
              pushed = true;
              setTimeout(() => {
                handle.release?.();
                onLost();
              }, 100);
            }
          },
          () => {
            // Told by the test.
          }
        );
        handle.release = followed.release;
        return followed;
      },
    });
    const waiting = reading(client, secrets, {});
    const followed = reading(client, apiOf(opened.release).list, {
      pagination: {},
    });
    await eventually(() => {
      expect({
        secrets: JSON.stringify(waiting.now().value).includes("Builders only"),
        lost: secretsFollows > 1,
        list: shown(followed.now()),
      }).toStrictEqual({ secrets: true, lost: true, list: [] });
    });

    try {
      await opened.builder.api.apps.members.add(opened.app, {
        ...them,
        role: "user",
      });

      await vi.waitFor(() => {
        expect(followed.now().error?.code).toBe("screen.access_changed");
      }, deliveryWait);
      expect(waiting.now().value).toBeUndefined();
    } finally {
      held.resolve(null);
    }
  });

  it("refuses as a failure to try again, not a lost role, when the role can't be read for a moment", async () => {
    const opened = await openedApp();
    const { lease, member } = await memberOf(opened);
    const flaky = flakyDb(sharedWithQueries);
    const { core } = await openRpc(member.session, { coreEnv: flaky.env });
    const tab = core.authenticate().screens;
    const follower = await followedList(opened, tab, lease);

    flaky.fail();
    await appHost(env, opened.app).accessRevoked([member.userId]);

    await expect(whenLetGo(follower)).resolves.toStrictEqual({
      last: "internal.unexpected",
      released: true,
    });
  });

  it("reads one App's query once, though another App's access is looked at again while it is read", async () => {
    const opened = await openedApp();
    const other = await openedApp();
    const { lease, member } = await memberOf(opened);
    await other.builder.api.apps.members.add(other.app, {
      type: "person",
      id: member.userId,
      role: "user",
    });
    const { lease: otherLease } = await member.api.screens.open(
      other.app,
      "notes"
    );
    await followedList(other, member.api.screens, otherLease);
    const pageSize = 7;
    const reads = await holdPageReads(opened, pageSize);
    try {
      const follower = pageFollower();
      await member.api.screens
        .frame(opened.app, lease)
        .watchQuery(
          requestOf(apiOf(opened.release).list, { pagination: { pageSize } }),
          follower.callback
        );
      await eventually(() => {
        expect(reads.count()).toBe(1);
      });

      // While this App's query is read, the other App's host tells the
      // connection to look again: only the other App's queries look.
      await expect(
        appHost(env, other.app).accessRevoked([member.userId])
      ).resolves.toBe(1);
      await scheduler.wait(500);
      reads.release();

      await eventually(() => {
        expect(follower.received.at(-1)?.result.ok).toBeTruthy();
      });
      await scheduler.wait(1000);
      expect({
        reads: reads.count(),
        pushes: follower.received.length,
      }).toStrictEqual({ reads: 1, pushes: 1 });
    } finally {
      reads.restore();
    }
  });

  it("reads nothing of an App until the host that let go of it early takes the connection on again", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const demoted = await personApi("admin");
    const { lease } = await demoted.api.screens.open(opened.app, "notes");
    const { core } = await openRpc(demoted.session);
    const tab = core.authenticate().screens;
    // The host lets go of the connection's first following at once, and
    // takes the next one on only `followDelayMs` later.
    const undo = await lettingGoEarly(opened);
    try {
      const follower = pageFollower();
      await tab
        .frame(opened.app, lease)
        .watchQuery(
          requestOf(apiOf(opened.release).list, { pagination: {} }),
          follower.callback
        );
      await scheduler.wait(500);
      // Before the next following: no host tells the connection of this.
      await admin.api.members.setRole(demoted.userId, "user");

      await vi.waitFor(
        () => {
          expect(follower.state.released).toBeTruthy();
        },
        { ...deliveryWait, timeout: deliveryWait.timeout + followDelayMs }
      );
      expect(follower.received.map(({ result }) => result.ok)).toStrictEqual([
        false,
      ]);
    } finally {
      undo();
    }
  });

  it("refuses as a failure to try again, not a lost role, when the App can't be looked up for a moment", async () => {
    const opened = await openedApp();
    const { lease, member } = await memberOf(opened);
    const flaky = flakyDb(appLookup);
    const { core } = await openRpc(member.session, { coreEnv: flaky.env });
    const tab = core.authenticate().screens;
    const follower = await followedList(opened, tab, lease);

    flaky.fail();
    await appHost(env, opened.app).accessRevoked([member.userId]);

    await expect(whenLetGo(follower)).resolves.toStrictEqual({
      last: "internal.unexpected",
      released: true,
    });
  });

  it("tells an App's host later, from the clock, when it can't be reached when access drops", async () => {
    const opened = await openedApp();
    const { them, lease, member } = await memberOf(opened);
    const follower = await followedList(opened, member.api.screens, lease);
    // The builder's own connection, whose word to the App's host that
    // access dropped never arrives.
    const { core } = await openRpc(opened.cookie, {
      coreEnv: { ...env, APPS: unreachableRevocations(env.APPS) },
    });

    await core.authenticate().apps.members.remove(opened.app, them);
    await scheduler.wait(1500);
    const before = follower.state.released;
    await runMinuteTasks();

    expect(before).toBeFalsy();
    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("drops a kept revocation once it is a day old, however many others the clock tells first", async () => {
    const opened = await openedApp();
    const now = Date.now();
    const keep = env.DB.prepare(
      "insert into access_revocations (id, app_id, user_ids, attempts, created_at) values (?, ?, null, ?, ?)"
    );
    const expired = crypto.randomUUID();
    // More than one run tells, none tried yet: each run reaches them
    // before the old one, which was tried once.
    const fresh = Array.from({ length: 101 }, () =>
      keep.bind(crypto.randomUUID(), opened.app, 0, now)
    );
    await env.DB.batch([
      ...fresh,
      keep.bind(expired, opened.app, 1, now - 25 * 60 * 60 * 1000),
    ]);

    await runMinuteTasks();

    const left = await env.DB.prepare(
      "select id from access_revocations where id = ?"
    )
      .bind(expired)
      .first();
    expect(left).toBeNull();
  });

  it("clears the screen from the clock when the database goes away right after an unsharing commits", async () => {
    const opened = await openedApp();
    const { them, lease, member } = await memberOf(opened);
    const follower = await followedList(opened, member.api.screens, lease);
    // The builder's own connection: nothing after the unsharing's batch
    // reaches the database, and the App's host can't be told.
    const { core } = await openRpc(opened.cookie, {
      coreEnv: {
        ...env,
        DB: awayAfterTheChange(),
        APPS: unreachableRevocations(env.APPS),
      },
    });

    await outcome(core.authenticate().apps.members.remove(opened.app, them));
    await scheduler.wait(1500);
    const before = follower.state.released;
    await runMinuteTasks();

    expect(before).toBeFalsy();
    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("clears the screen of someone removed who reached the App through a team, from the clock when the database goes away right after", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const member = await personApi("user");
    const team = await newTeam(admin, [member]);
    await admin.api.apps.members.add(opened.app, {
      type: "team",
      id: team,
      role: "user",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    const follower = await followedList(opened, member.api.screens, lease);
    // The admin's own connection: nothing after the removal's batch, which
    // takes their teams away too, reaches the database, and the App's host
    // can't be told.
    const { core } = await openRpc(admin.session, {
      coreEnv: {
        ...env,
        DB: awayAfterTheChange(),
        APPS: unreachableRevocations(env.APPS),
      },
    });

    await outcome(core.authenticate().members.remove(member.userId));
    await scheduler.wait(1500);
    const before = follower.state.released;
    await runMinuteTasks();

    expect(before).toBeFalsy();
    await expect(whenLetGo(follower)).resolves.toStrictEqual({
      last: "auth.unauthenticated",
      released: true,
    });
  });

  it("clears the screen of someone removed who was made an admin after the removal read their role, of an App only admins reach", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const removed = await personApi("admin");
    const { lease } = await removed.api.screens.open(opened.app, "notes");
    const follower = await followedList(opened, removed.api.screens, lease);
    // A user as the removal reads them first; an admin again by its batch.
    await env.DB.prepare("update members set role = 'user' where user_id = ?")
      .bind(removed.userId)
      .run();
    const { core } = await openRpc(admin.session, {
      coreEnv: { ...env, DB: promotedBeforeTheChange(removed.userId) },
    });

    await core.authenticate().members.remove(removed.userId);

    await expect(whenLetGo(follower)).resolves.toStrictEqual({
      last: "auth.unauthenticated",
      released: true,
    });
  });

  it("keeps one revocation for every App when an admin is removed or demoted, however many Apps there are", async () => {
    const admin = await personApi("admin");
    const removed = await personApi("admin");
    const demoted = await personApi("admin");
    await manyApps(admin.userId, 1000, [removed.userId, demoted.userId]);
    // Connections on which nothing after the change's batch reaches the
    // database: what the batch kept is all there is.
    const changing = async () => {
      const { core } = await openRpc(admin.session, {
        coreEnv: {
          ...env,
          DB: awayAfterTheChange(),
          APPS: unreachableRevocations(env.APPS),
        },
      });
      return core;
    };
    const removing = await changing();
    await outcome(removing.authenticate().members.remove(removed.userId));
    const demoting = await changing();
    await outcome(
      demoting.authenticate().members.setRole(demoted.userId, "user")
    );

    expect({
      removed: await organizationRoleOf(removed.userId),
      demoted: await organizationRoleOf(demoted.userId),
      keptForRemoved: await keptForPerson(removed.userId),
      keptForDemoted: await keptForPerson(demoted.userId),
    }).toStrictEqual({
      removed: null,
      demoted: "user",
      keptForRemoved: [
        {
          appId: null,
          userIds: JSON.stringify([removed.userId]),
          afterAppId: null,
        },
      ],
      keptForDemoted: [
        {
          appId: null,
          userIds: JSON.stringify([demoted.userId]),
          afterAppId: null,
        },
      ],
    });
  });

  it("expands a revocation for every App a page at a time from the clock, until each App has its own", async () => {
    const admin = await personApi("admin");
    const removed = await personApi("admin");
    await manyApps(admin.userId, 450, [removed.userId]);
    const { core } = await openRpc(admin.session, {
      coreEnv: {
        ...env,
        DB: awayAfterTheChange(),
        APPS: unreachableRevocations(env.APPS),
      },
    });
    await outcome(core.authenticate().members.remove(removed.userId));
    const theirs = JSON.stringify([removed.userId]);
    const kept = async () => {
      const row = await env.DB.prepare(
        "select count(distinct app_id) as apps, count(*) - count(app_id) as everyApp from access_revocations where user_ids = ?"
      )
        .bind(theirs)
        .first<{ apps: number; everyApp: number }>();
      return row ?? { apps: 0, everyApp: 0 };
    };
    const allApps = await env.DB.prepare(
      "select count(*) as apps from apps"
    ).first<number>("apps");
    // Hosts that can't be told keep each App's row, so it can be counted.
    const unreachable = { APPS: unreachableRevocations(env.APPS) };
    const runs: { apps: number; everyApp: number }[] = [await kept()];
    while ((runs.at(-1)?.everyApp ?? 0) > 0 && runs.length < 10) {
      // oxlint-disable-next-line no-await-in-loop -- one run after the other
      await revocationsClock(unreachable);
      // oxlint-disable-next-line no-await-in-loop -- see above
      runs.push(await kept());
    }

    // Each run expands whole pages of 200 Apps, as many as its budget
    // allows, and the row goes with the last one.
    const between = runs.slice(1, -1);
    expect({
      first: runs[0],
      between: between.every(
        ({ apps, everyApp }) => everyApp === 1 && apps > 0 && apps % 200 === 0
      ),
      growing: runs.every(
        (run, index) => index === 0 || run.apps > (runs[index - 1]?.apps ?? 0)
      ),
      last: runs.at(-1),
    }).toStrictEqual({
      first: { apps: 0, everyApp: 1 },
      between: true,
      growing: true,
      last: { apps: allApps, everyApp: 0 },
    });
  });

  it("expands a revocation for every App once, whichever expansions reach the same page together", async () => {
    const admin = await personApi("admin");
    const removed = await personApi("admin");
    await manyApps(admin.userId, 450, [removed.userId]);
    const { core } = await openRpc(admin.session, {
      coreEnv: {
        ...env,
        DB: awayAfterTheChange(),
        APPS: unreachableRevocations(env.APPS),
      },
    });
    await outcome(core.authenticate().members.remove(removed.userId));
    const unreachable = { APPS: unreachableRevocations(env.APPS) };
    const everyAppLeft = async () =>
      await env.DB.prepare(
        "select count(*) as left from access_revocations where app_id is null and user_ids = ?"
      )
        .bind(JSON.stringify([removed.userId]))
        .first<number>("left");
    let left = await everyAppLeft();
    for (let runs = 0; runs < 10 && left !== 0; runs += 1) {
      // Two runs at once, each reading the same cursor.
      // oxlint-disable-next-line no-await-in-loop -- a pair after the other
      await Promise.all([
        revocationsClock(unreachable),
        revocationsClock(unreachable),
      ]);
      // oxlint-disable-next-line no-await-in-loop -- see above
      left = await everyAppLeft();
    }

    const counted = await env.DB.prepare(
      "select count(*) as rows, count(distinct app_id) as apps from access_revocations where app_id is not null and user_ids = ?"
    )
      .bind(JSON.stringify([removed.userId]))
      .first<{ rows: number; apps: number }>();
    const allApps = await env.DB.prepare(
      "select count(*) as apps from apps"
    ).first<number>("apps");
    expect({ left, counted }).toStrictEqual({
      left: 0,
      counted: { rows: allApps, apps: allApps },
    });
  });

  it("keeps expanding a revocation for every App past a day, and drops it, logged, past a week or ten failed expansions", async () => {
    const admin = await personApi("admin");
    const [dayOld, weekOld, failing] = await Promise.all([
      personApi("admin"),
      personApi("admin"),
      personApi("admin"),
    ]);
    await manyApps(admin.userId, 450, [
      dayOld.userId,
      weekOld.userId,
      failing.userId,
    ]);
    for (const person of [dayOld, weekOld, failing]) {
      // oxlint-disable-next-line no-await-in-loop -- one removal after the other
      const { core } = await openRpc(admin.session, {
        coreEnv: {
          ...env,
          DB: awayAfterTheChange(),
          APPS: unreachableRevocations(env.APPS),
        },
      });
      // oxlint-disable-next-line no-await-in-loop -- see above
      await outcome(core.authenticate().members.remove(person.userId));
    }
    const hourMs = 60 * 60 * 1000;
    const age = env.DB.prepare(
      "update access_revocations set created_at = ?, attempts = ? where app_id is null and user_ids = ?"
    );
    await env.DB.batch([
      age.bind(Date.now() - 25 * hourMs, 0, JSON.stringify([dayOld.userId])),
      age.bind(
        Date.now() - 8 * 24 * hourMs,
        0,
        JSON.stringify([weekOld.userId])
      ),
      age.bind(Date.now(), 10, JSON.stringify([failing.userId])),
    ]);

    await revocationsClock({ APPS: unreachableRevocations(env.APPS) });

    const dayOldKept = await everyAppKeptFor(dayOld.userId);
    expect({
      // Expanded on, however far the run's budget went.
      dayOld: (dayOldKept?.apps ?? 0) >= 200,
      weekOld: await everyAppKeptFor(weekOld.userId),
      failing: await everyAppKeptFor(failing.userId),
    }).toStrictEqual({
      dayOld: true,
      weekOld: { everyApp: 0, apps: 0 },
      failing: { everyApp: 0, apps: 0 },
    });
  });

  it("clears the screen of an admin demoted out of an App past the first pages of Apps, at once", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const demoted = await personApi("admin");
    // Before it in ID order: it is on the third page.
    await manyApps(admin.userId, 450, [demoted.userId], "!");
    const { lease } = await demoted.api.screens.open(opened.app, "notes");
    const follower = await followedList(opened, demoted.api.screens, lease);
    // The admin's own connection, whose word reaches only the opened App's
    // host and takes no time for the others: what is told at once is
    // what the change's own budget expands, however fast hosts wake.
    const told = { others: 0 };
    const { core } = await openRpc(admin.session, {
      coreEnv: {
        ...env,
        APPS: quickRevocations(env.APPS, opened.app, told),
      },
    });

    await core.authenticate().members.setRole(demoted.userId, "user");

    expect(told.others).toBeGreaterThanOrEqual(450);
    await expect(whenLetGo(follower)).resolves.toStrictEqual(refusedAndLetGo);
  });

  it("clears the screen of an admin removed from the organization, from the clock when the database goes away right after", async () => {
    const opened = await openedApp();
    const admin = await personApi("admin");
    const removed = await personApi("admin");
    const { lease } = await removed.api.screens.open(opened.app, "notes");
    const follower = await followedList(opened, removed.api.screens, lease);
    const { core } = await openRpc(admin.session, {
      coreEnv: {
        ...env,
        DB: awayAfterTheChange(),
        APPS: unreachableRevocations(env.APPS),
      },
    });

    await outcome(core.authenticate().members.remove(removed.userId));
    await scheduler.wait(1500);
    const before = follower.state.released;
    // Only the opened App's host is woken: an every-App revocation tells
    // every App the earlier tests of this file made, and each host woken
    // costs the test runtime (vitest-pool-workers nests a proxy per object
    // it constructs).
    const told = { others: 0 };
    await revocationsClock({
      APPS: quickRevocations(env.APPS, opened.app, told),
    });

    expect(before).toBeFalsy();
    await expect(whenLetGo(follower)).resolves.toStrictEqual({
      last: "auth.unauthenticated",
      released: true,
    });
  });

  it("stops showing builders' data to someone lowered to user, from the clock when the database goes away right after", async () => {
    const opened = await openedApp(withSecrets());
    const tell = referenceTo<{ text: string }, unknown, "mutation">(
      opened.release,
      "notes.tell"
    );
    const secrets = referenceTo<Record<never, never>, unknown, "query">(
      opened.release,
      "notes.secrets"
    );
    await clientFor(opened).client.mutation(tell, { text: "Builders only" });
    const admin = await personApi("admin");
    const member = await personApi("builder");
    await opened.builder.api.apps.members.add(opened.app, {
      type: "person",
      id: member.userId,
      role: "builder",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    const follower = pageFollower();
    await member.api.screens
      .frame(opened.app, lease)
      .watchQuery(requestOf(secrets, {}), follower.callback);
    const showsSecret = () =>
      JSON.stringify(follower.received.at(-1)?.result).includes(
        "Builders only"
      );
    await eventually(() => {
      expect(showsSecret()).toBeTruthy();
    });
    // The admin's own connection: nothing after the change's batch
    // reaches the database, and the App's host can't be told.
    const { core } = await openRpc(admin.session, {
      coreEnv: {
        ...env,
        DB: awayAfterTheChange(),
        APPS: unreachableRevocations(env.APPS),
      },
    });

    await outcome(core.authenticate().members.setRole(member.userId, "user"));
    await scheduler.wait(1500);
    const before = showsSecret();
    await runMinuteTasks();

    expect(before).toBeTruthy();
    await vi.waitFor(() => {
      expect(showsSecret()).toBeFalsy();
    }, deliveryWait);
  });

  it("keeps no revocation once the App's host is told, nor for a sharing that changed nothing", async () => {
    const opened = await openedApp();
    const { them } = await memberOf(opened);
    const keptFor = async () =>
      await env.DB.prepare(
        "select count(*) as kept from access_revocations where app_id = ?"
      )
        .bind(opened.app)
        .first<number>("kept");
    // A connection that can't tell the App's host: whatever it keeps
    // stays for the clock.
    const { core } = await openRpc(opened.cookie, {
      coreEnv: { ...env, APPS: unreachableRevocations(env.APPS) },
    });

    // Shared again in the role it has: nothing changes.
    await core.authenticate().apps.members.add(opened.app, {
      ...them,
      role: "user",
    });
    const keptForNothing = await keptFor();
    // Unshared over a connection that tells the App's host at once.
    await opened.builder.api.apps.members.remove(opened.app, them);

    expect({ keptForNothing, keptOnceTold: await keptFor() }).toStrictEqual({
      keptForNothing: 0,
      keptOnceTold: 0,
    });
  });

  it("reads again for someone who is now only a user, rather than keep showing what builders read", async () => {
    const opened = await openedApp(withSecrets());
    const tell = referenceTo<{ text: string }, unknown, "mutation">(
      opened.release,
      "notes.tell"
    );
    const secrets = referenceTo<Record<never, never>, unknown, "query">(
      opened.release,
      "notes.secrets"
    );
    await clientFor(opened).client.mutation(tell, { text: "Builders only" });
    const member = await personApi("builder");
    const them = { type: "person", id: member.userId } as const;
    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "builder",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    const follower = pageFollower();
    await member.api.screens
      .frame(opened.app, lease)
      .watchQuery(requestOf(secrets, {}), follower.callback);
    const showsSecret = () =>
      JSON.stringify(follower.received.at(-1)?.result).includes(
        "Builders only"
      );
    await eventually(() => {
      expect(showsSecret()).toBeTruthy();
    });

    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "user",
    });

    await vi.waitFor(() => {
      expect(showsSecret()).toBeFalsy();
    }, deliveryWait);
  });

  it("drops what a screen kept from before the person became only a user, while the query it follows shows nothing yet", async () => {
    const opened = await openedApp(withSecrets());
    const tell = referenceTo<{ text: string }, unknown, "mutation">(
      opened.release,
      "notes.tell"
    );
    const secrets = referenceTo<Record<never, never>, unknown, "query">(
      opened.release,
      "notes.secrets"
    );
    await clientFor(opened).client.mutation(tell, { text: "Builders only" });
    const member = await personApi("builder");
    const them = { type: "person", id: member.userId } as const;
    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "builder",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    const { client } = clientFor(
      { ...opened, lease, cookie: member.session, userId: member.userId },
      member.api.screens
    );
    const kept = reading(client, secrets, {});
    await eventually(() => {
      expect(JSON.stringify(kept.now().value)).toContain("Builders only");
    });
    // No longer shown: the client keeps it for a while.
    kept.stop();
    const pageSize = 9;
    const reads = await holdPageReads(opened, pageSize);
    try {
      // Followed, its first read held: it has shown nothing yet.
      const pending = reading(client, apiOf(opened.release).list, {
        pagination: { pageSize },
      });
      await eventually(() => {
        expect(reads.count()).toBe(1);
      });

      await opened.builder.api.apps.members.add(opened.app, {
        ...them,
        role: "user",
      });

      await vi.waitFor(() => {
        expect(pending.now().error?.code).toBe("screen.access_changed");
      }, deliveryWait);
      expect(kept.now().value).toBeUndefined();
    } finally {
      reads.restore();
    }
  });

  it("shows nothing a screen kept from before the person became only a user, followed or not", async () => {
    const opened = await openedApp(withSecrets());
    const tell = referenceTo<{ text: string }, unknown, "mutation">(
      opened.release,
      "notes.tell"
    );
    const secrets = referenceTo<Record<never, never>, unknown, "query">(
      opened.release,
      "notes.secrets"
    );
    await clientFor(opened).client.mutation(tell, { text: "Builders only" });
    const member = await personApi("builder");
    const them = { type: "person", id: member.userId } as const;
    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "builder",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    const { client } = clientFor(
      { ...opened, lease, cookie: member.session, userId: member.userId },
      member.api.screens
    );
    const followed = reading(client, secrets, {});
    // Read once, then no longer shown: the client keeps it for a while.
    const kept = reading(client, apiOf(opened.release).list, {
      pagination: {},
    });
    await eventually(() => {
      expect({
        followed: JSON.stringify(followed.now().value).includes(
          "Builders only"
        ),
        kept: shown(kept.now()),
      }).toStrictEqual({ followed: true, kept: [] });
    });
    kept.stop();

    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "user",
    });

    await vi.waitFor(() => {
      expect(followed.now().error?.code).toBe("screen.access_changed");
    }, deliveryWait);
    expect(kept.now()).toMatchObject({ value: undefined });
    // Read again, it is read afresh, under the roles they have now.
    const again = reading(client, apiOf(opened.release).list, {
      pagination: {},
    });
    await eventually(() => {
      expect(shown(again.now())).toStrictEqual([]);
    });
  });
});
