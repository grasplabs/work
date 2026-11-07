import {
  AppError,
  defineApp,
  defineSchema,
  defineTable,
  v,
} from "@grasp-os/sdk";
import { inspectApp, manifestText, registerApp } from "@grasp-os/sdk/host";
import { runFunction } from "@grasp-os/sdk/runner";
import { serverModule } from "@grasp-os/sdk/server";
import {
  releaseFormatVersion,
  releaseManifestSchema,
} from "@grasp-os/shared/app-releases";
import { sha256Hex } from "@grasp-os/shared/encoding";
import {
  appIdSchema,
  chatIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalText } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { appNotificationsPerHour } from "@grasp-os/shared/notifications";
import type { OperationResult } from "@grasp-os/shared/operations";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { invocationFor, visitorInvocation } from "../src/app-functions.ts";
import {
  appPeopleNotifications,
  dispatchAppNotifyIntent,
} from "../src/app-notifications.ts";
import type { Release } from "../src/app-releases.ts";
import { openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { listNotifications } from "../src/notifications.ts";
import { callOperation } from "../src/operations.ts";
import type { HostedApp, Invocation } from "../src/operations.ts";
import { storeOfNewApp } from "./app-stores.ts";
import { racingDb } from "./apps.ts";
import { allEvents } from "./audit-events.ts";

// Apps telling people (app-notifications.ts): an action's
// `ctx.notifyPeople` and a mutation's `ctx.afterCommit.notifyPeople`, through the real operation host,
// a real business store and its outbox, into the person's notifications
// as their inbox lists them. App code runs as the SDK's runner runs it.

const schema = defineSchema({
  orders: defineTable({ title: v.string() }).access({
    read: "appMembers",
    write: "appMembers",
  }),
});

const { mutation, action } = serverModule(schema);

const receiptSchema = v.object({ delivered: v.number().integer() });

/** Tells `to` now. */
const tell = action({
  args: { to: v.string(), title: v.string() },
  returns: receiptSchema,
  handler: async (ctx, args) =>
    await ctx.notifyPeople(args.to, {
      title: args.title,
      body: "Order 42 waits for your approval.",
    }),
});

/** Records an order, and tells `to` once it commits. */
const place = mutation({
  args: { to: v.string(), fail: v.boolean().default(false) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("orders", { title: "Order" });
    await ctx.afterCommit.notifyPeople(args.to, {
      title: "An order was placed",
    });
    if (args.fail) {
      throw new AppError("orders.refused", "The order was refused.");
    }
    return null;
  },
});

/** Tells `to` once it commits, writing nothing: what a visitor may call. */
const ping = mutation({
  args: { to: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.afterCommit.notifyPeople(args.to, { title: "Ping" });
    return null;
  },
});

const ordersApp = registerApp({
  config: defineApp({ name: "Orders" }),
  schema,
  modules: { orders: { tell, place, ping } },
  migrations: [],
});

const { manifest } = inspectApp(ordersApp);

const hosted: HostedApp = {
  manifest,
  run: async (path, args, channel) =>
    await runFunction(ordersApp, path, args, channel),
};

const kinds = {
  "orders.tell": "action",
  "orders.place": "mutation",
  "orders.ping": "mutation",
} as const;

/** A member of the organization in `role`. */
const person = async (role: Role): Promise<Identity> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, ?, ?)"
    ).bind(crypto.randomUUID(), userId, role, Date.now()),
  ]);
  return {
    userId,
    email: `${userId}@acme.test`,
    name: "Person",
    role,
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
};

/** A team of the organization with `members` in it. */
const teamOf = async (members: readonly Identity[]): Promise<string> => {
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, 'Sales', 'organization', ?)"
    ).bind(id, Date.now()),
    ...members.map((member) =>
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), id, member.userId, Date.now())
    ),
  ]);
  return id;
};

const zeros = "0".repeat(64);

interface Fixture {
  /** Builds the App. */
  readonly ada: Identity;
  /** Uses the App. */
  readonly bob: Identity;
  /** A member of the organization the App isn't shared with. */
  readonly carol: Identity;
  readonly app: AppId;
  readonly store: OpenStore;
  readonly release: Release;
}

/** Ada's published App, version 1 sealed, with its store, shared with Bob. */
const fixture = async (): Promise<Fixture> => {
  const ada = await person("builder");
  const bob = await person("user");
  const carol = await person("user");
  const app = appIdSchema.parse(crypto.randomUUID());
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO apps (id, name, description, owner_id, status, created_at) VALUES (?, 'Orders', '', ?, 'published', ?)"
    ).bind(app, ada.userId, Date.now()),
    env.DB.prepare(
      "INSERT INTO app_versions (app_id, version, tree, files, author_id, message, created_at, approved) VALUES (?, 1, 'tree', 0, ?, 'Version', ?, 1)"
    ).bind(app, ada.userId, Date.now()),
    env.DB.prepare(
      "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
    ).bind(app, bob.userId, ada.userId, Date.now()),
  ]);
  const sealed = releaseManifestSchema.parse({
    formatVersion: releaseFormatVersion,
    resourceId: app,
    resourceVersion: 1,
    sourceTreeHash: zeros,
    schemaHash: zeros,
    contractHash: zeros,
    sdkVersion: "1.0.0",
    uiVersion: "1.0.0",
    compilerVersion: "1.0.0",
    dependencyLockHash: zeros,
    target: "app",
    dataStoreBindings: [],
    artifacts: [{ path: "server.js", sha256: zeros, bytes: 0 }],
    bindings: [],
    verificationReportHash: zeros,
    migrationEvidence: [],
    artifactTrust: "unreviewed",
  });
  const text = canonicalText(sealed);
  const hash = await sha256Hex(text);
  await env.DB.prepare(
    "INSERT INTO sdk_release_manifests (app_id, version, manifest_hash, manifest, sealed_at, revoked_at) VALUES (?, 1, ?, ?, ?, NULL)"
  )
    .bind(app, hash, text, Date.now())
    .run();
  const storeId = await storeOfNewApp(env, ada);
  const store = await openStore(env, storeId);
  await store.defineTables(manifestText(manifest.schema));
  return {
    ada,
    bob,
    carol,
    app,
    store,
    release: {
      manifest: sealed,
      manifestHash: hash,
      app: manifest,
      fingerprints: {},
      modules: {},
      sdk: {},
      store: {
        alias: "orders",
        storeId,
        schemaVersion: 1,
        schemaHash: zeros,
        operationManifestHash: zeros,
      },
      workflows: [],
    },
  };
};

/** Calls `path` through `invocation`, as a page would. */
const callWith = async (
  invocation: Invocation,
  path: keyof typeof kinds,
  args: Json,
  key?: string
): Promise<OperationResult> =>
  await callOperation(
    hosted,
    invocation,
    { path, kind: kinds[path] },
    args,
    key === undefined ? {} : { idempotencyKey: key }
  );

/** Calls `path` as `by`, a member, through the App's invocation. */
const call = async (
  fx: Fixture,
  by: Identity,
  path: keyof typeof kinds,
  args: Json,
  options: { key?: string; runEnv?: Env } = {}
): Promise<OperationResult> =>
  await callWith(
    await invocationFor(options.runEnv ?? env, fx.release, {
      by,
      requestId: crypto.randomUUID(),
      deadline: Date.now() + 30_000,
    }),
    path,
    args,
    options.key
  );

/** What a call answered, or the code it failed with. */
const answerOf = (result: OperationResult): unknown =>
  result.ok ? result.value : result.error.code;

/** What `by`'s notifications list says the App told them. */
const toldTo = async (by: Identity) => {
  const page = await listNotifications(env, by);
  return page.notifications.flatMap((notification) =>
    notification.type === "app_message"
      ? [
          {
            app: notification.app,
            appName: notification.appName,
            title: notification.title,
            body: notification.body,
            read: notification.read,
          },
        ]
      : []
  );
};

/** Hands the store's outbox over, as its alarm does. */
const drain = async (fx: Fixture): Promise<void> => {
  await runDurableObjectAlarm(env.DATA_STORES.getByName(fx.store.id));
};

/** The audit events of `name` on App `app`, oldest first: actor and detail. */
const auditedOf = async (name: string, app: AppId) => {
  const logged = await allEvents();
  return logged
    .filter((event) => event.action === name && event.target?.id === app)
    .map(({ actor, detail }) => ({ actor, detail }));
};

/** The details alone of `name`'s audit events on App `app`. */
const detailsOf = async (name: string, app: AppId) => {
  const audited = await auditedOf(name, app);
  return audited.map(({ detail }) => detail);
};

/** How many `name` audit events App `app` has. */
const countOf = async (name: string, app: AppId): Promise<number> => {
  const details = await detailsOf(name, app);
  return details.length;
};

/** The titles of what the App told `by`, latest first. */
const titlesTo = async (by: Identity): Promise<string[]> => {
  const told = await toldTo(by);
  return told.map(({ title }) => title);
};

/** The store's outbox entries as settled: whether they are, and as what. */
const settledOf = async (store: OpenStore) =>
  await runInDurableObject(
    env.DATA_STORES.getByName(store.id),
    (_instance, state) =>
      state.storage.sql
        .exec<{ settled_at: number | null; undeliverable: string | null }>(
          "SELECT settled_at, undeliverable FROM sdk_change_outbox ORDER BY rowid"
        )
        .toArray()
        .map(({ settled_at, undeliverable }) => ({
          settled: settled_at !== null,
          undeliverable,
        }))
  );

/** People in the organization, `count` of them, in one team shared with the App. */
const sharedTeam = async (fx: Fixture, count: number): Promise<string> => {
  const people = await Promise.all(
    Array.from({ length: count }, async () => await person("user"))
  );
  const team = await teamOf(people);
  await env.DB.prepare(
    "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'team', ?, 'user', ?, ?)"
  )
    .bind(fx.app, team, fx.ada.userId, Date.now())
    .run();
  return team;
};

/** What the App sent this hour already, to others: `count` notifications. */
const sentEarlier = async (fx: Fixture, count: number): Promise<void> => {
  const now = Date.now();
  await env.DB.batch(
    Array.from({ length: count }, () =>
      env.DB.prepare(
        "INSERT INTO notifications (id, person_id, type, app_id, title, created_at, updated_at) VALUES (?, ?, 'app_message', ?, 'Earlier', ?, ?)"
      ).bind(crypto.randomUUID(), crypto.randomUUID(), fx.app, now, now)
    )
  );
};

/** An outbox entry of a commit of Bob's telling `to`, as the store hands it over. */
const entryOf = (
  fx: Fixture,
  to: string,
  agent: Parameters<typeof appPeopleNotifications>[2] = null
) => ({
  id: crypto.randomUUID(),
  intent: {
    kind: "app.notify" as const,
    data: appPeopleNotifications(
      env,
      {
        subject: { type: "app", appId: fx.app },
        onBehalfOf: fx.bob.userId,
        mode: "interactive",
        appVersion: 1,
      },
      agent
    ).intent(to, { title: "Dispatched" }),
  },
  attempts: 0,
  signal: new AbortController().signal,
});

describe("an action's ctx.notifyPeople", () => {
  it("reaches a member's notifications, opening the App, and audits the send without its words", async () => {
    const fx = await fixture();
    const sent = await call(fx, fx.bob, "orders.tell", {
      to: fx.bob.userId,
      title: "Approve order 42",
    });
    expect({
      answer: answerOf(sent),
      bob: await toldTo(fx.bob),
      audited: await auditedOf("app.notification.sent", fx.app),
    }).toStrictEqual({
      answer: { delivered: 1 },
      bob: [
        {
          app: fx.app,
          appName: "Orders",
          title: "Approve order 42",
          body: "Order 42 waits for your approval.",
          read: false,
        },
      ],
      audited: [
        {
          actor: { type: "app", appId: fx.app, part: "server" },
          detail: {
            appVersion: 1,
            principal: fx.bob.userId,
            via: "action",
            told: 1,
            skipped: 0,
          },
        },
      ],
    });
  });

  it("skips whoever can't open the App, never refusing the send", async () => {
    const fx = await fixture();
    const sales = await teamOf([fx.bob, fx.carol]);
    const toStranger = await call(fx, fx.bob, "orders.tell", {
      to: crypto.randomUUID(),
      title: "Hello",
    });
    const toCarol = await call(fx, fx.bob, "orders.tell", {
      to: fx.carol.userId,
      title: "Hello",
    });
    const toTeam = await call(fx, fx.bob, "orders.tell", {
      to: sales,
      title: "To the team",
    });
    expect({
      stranger: answerOf(toStranger),
      carol: answerOf(toCarol),
      team: answerOf(toTeam),
      carolTold: await toldTo(fx.carol),
      bobTold: await titlesTo(fx.bob),
    }).toStrictEqual({
      stranger: { delivered: 0 },
      carol: { delivered: 0 },
      team: { delivered: 1 },
      carolTold: [],
      bobTold: ["To the team"],
    });
  });

  it("tells nobody twice, and logs the send once, for a call made again under the same key after the log took the first", async () => {
    const fx = await fixture();
    const key = crypto.randomUUID();
    const args = { to: fx.bob.userId, title: "Once" };
    const first = await call(fx, fx.ada, "orders.tell", args, { key });
    // The audit outbox drained into the log between the two.
    await allEvents();
    const again = await call(fx, fx.ada, "orders.tell", args, { key });
    const logged = await allEvents();
    expect({
      first: answerOf(first),
      again: answerOf(again),
      told: await titlesTo(fx.bob),
      sent: await countOf("app.notification.sent", fx.app),
      gaps: logged.filter((event) => event.action === "audit.gap").length,
    }).toStrictEqual({
      first: { delivered: 1 },
      again: { delivered: 1 },
      told: ["Once"],
      sent: 1,
      gaps: 0,
    });
  });

  it("tells nobody, and says it reached nobody rather than the limit, when everyone it names leaves as it is sent", async () => {
    const fx = await fixture();
    const db = racingDb(async () => {
      await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
        .bind(fx.bob.userId)
        .run();
    }, /insert into "notifications"/iu);
    const sent = await call(
      fx,
      fx.ada,
      "orders.tell",
      { to: fx.bob.userId, title: "Gone" },
      { runEnv: { ...env, DB: db } }
    );
    expect({
      answer: answerOf(sent),
      refused: await countOf("app.notification.refused", fx.app),
      sent: await detailsOf("app.notification.sent", fx.app),
    }).toStrictEqual({
      answer: { delivered: 0 },
      refused: 0,
      sent: [
        {
          appVersion: 1,
          principal: fx.ada.userId,
          via: "action",
          told: 0,
          skipped: 1,
        },
      ],
    });
  });

  it("refuses a title past its limit, telling nobody", async () => {
    const fx = await fixture();
    const sent = await call(fx, fx.bob, "orders.tell", {
      to: fx.bob.userId,
      title: "x".repeat(121),
    });
    expect({
      answer: answerOf(sent),
      told: await toldTo(fx.bob),
    }).toStrictEqual({ answer: "resource.invalid_args", told: [] });
  });

  it("holds the App's hourly limit, refusing a send past it whole and auditing it", async () => {
    const fx = await fixture();
    const sales = await teamOf([fx.ada, fx.bob]);
    // One short of its limit.
    await sentEarlier(fx, appNotificationsPerHour - 1);
    const toTeam = await call(fx, fx.bob, "orders.tell", {
      to: sales,
      title: "Two would pass it",
    });
    const toBob = await call(fx, fx.bob, "orders.tell", {
      to: fx.bob.userId,
      title: "One fits",
    });
    const past = await call(fx, fx.bob, "orders.tell", {
      to: fx.bob.userId,
      title: "Past it",
    });
    expect({
      team: answerOf(toTeam),
      bob: answerOf(toBob),
      past: answerOf(past),
      told: await titlesTo(fx.bob),
      refused: await detailsOf("app.notification.refused", fx.app),
    }).toStrictEqual({
      team: "resource.limit_reached",
      bob: { delivered: 1 },
      past: "resource.limit_reached",
      told: ["One fits"],
      refused: [
        {
          appVersion: 1,
          principal: fx.bob.userId,
          via: "action",
          reason: "resource.limit_reached",
          named: 2,
        },
        {
          appVersion: 1,
          principal: fx.bob.userId,
          via: "action",
          reason: "resource.limit_reached",
          named: 1,
        },
      ],
    });
  });

  it("lets only one of two sends at once past the limit, the other refused whole", async () => {
    const fx = await fixture();
    const sales = await teamOf([fx.ada, fx.bob]);
    // Room for the team's two, until another send lands first.
    await sentEarlier(fx, appNotificationsPerHour - 2);
    const db = racingDb(async () => {
      await call(fx, fx.bob, "orders.tell", {
        to: fx.ada.userId,
        title: "Got there first",
      });
    }, /insert into "notifications"/iu);
    const raced = await call(
      fx,
      fx.bob,
      "orders.tell",
      { to: sales, title: "Two at once" },
      { runEnv: { ...env, DB: db } }
    );
    expect({
      answer: answerOf(raced),
      ada: await titlesTo(fx.ada),
      bob: await titlesTo(fx.bob),
      sent: await countOf("app.notification.sent", fx.app),
      refused: await countOf("app.notification.refused", fx.app),
    }).toStrictEqual({
      answer: "resource.limit_reached",
      ada: ["Got there first"],
      bob: [],
      sent: 1,
      refused: 1,
    });
  });

  it("tells at most 50 people a send, the rest of a team skipped", async () => {
    const fx = await fixture();
    const team = await sharedTeam(fx, 51);
    const sent = await call(fx, fx.bob, "orders.tell", {
      to: team,
      title: "To everyone",
    });
    expect({
      answer: answerOf(sent),
      audited: await detailsOf("app.notification.sent", fx.app),
    }).toStrictEqual({
      answer: { delivered: 50 },
      audited: [
        {
          appVersion: 1,
          principal: fx.bob.userId,
          via: "action",
          told: 50,
          skipped: 1,
        },
      ],
    });
  });
});

describe("a mutation's ctx.afterCommit.notifyPeople", () => {
  it("tells a member once the commit lands and its outbox hands it over, audited", async () => {
    const fx = await fixture();
    const placed = await call(fx, fx.bob, "orders.place", {
      to: fx.ada.userId,
    });
    const before = await toldTo(fx.ada);
    await drain(fx);
    expect({
      answer: answerOf(placed),
      before,
      after: await toldTo(fx.ada),
      audited: await detailsOf("app.notification.sent", fx.app),
    }).toStrictEqual({
      answer: null,
      before: [],
      after: [
        {
          app: fx.app,
          appName: "Orders",
          title: "An order was placed",
          body: null,
          read: false,
        },
      ],
      audited: [
        {
          appVersion: 1,
          principal: fx.bob.userId,
          via: "mutation",
          told: 1,
          skipped: 0,
        },
      ],
    });
  });

  it("tells nobody for a mutation that fails", async () => {
    const fx = await fixture();
    const placed = await call(fx, fx.bob, "orders.place", {
      to: fx.ada.userId,
      fail: true,
    });
    await drain(fx);
    expect({
      answer: answerOf(placed),
      told: await toldTo(fx.ada),
    }).toStrictEqual({ answer: "orders.refused", told: [] });
  });

  it("decides whom it tells as it is sent: someone unshared or removed since the commit is skipped", async () => {
    const fx = await fixture();
    const sales = await teamOf([fx.bob, fx.carol]);
    await env.DB.prepare(
      "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
    )
      .bind(fx.app, fx.carol.userId, fx.ada.userId, Date.now())
      .run();
    const placed = await call(fx, fx.ada, "orders.place", { to: sales });
    await env.DB.batch([
      // Bob unshared, Carol out of the organization, after the commit.
      env.DB.prepare(
        "DELETE FROM app_members WHERE app_id = ? AND member_id = ?"
      ).bind(fx.app, fx.bob.userId),
      env.DB.prepare("DELETE FROM members WHERE user_id = ?").bind(
        fx.carol.userId
      ),
    ]);
    await drain(fx);
    expect({
      answer: answerOf(placed),
      bob: await toldTo(fx.bob),
      outbox: await settledOf(fx.store),
      audited: await detailsOf("app.notification.sent", fx.app),
    }).toStrictEqual({
      answer: null,
      bob: [],
      outbox: [{ settled: true, undeliverable: null }],
      audited: [
        {
          appVersion: 1,
          principal: fx.ada.userId,
          via: "mutation",
          told: 0,
          skipped: 2,
        },
      ],
    });
  });

  it("tells nobody once the person it acts for is out of the organization, audited", async () => {
    const fx = await fixture();
    const placed = await call(fx, fx.bob, "orders.place", {
      to: fx.ada.userId,
    });
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(fx.bob.userId)
      .run();
    await drain(fx);
    expect({
      answer: answerOf(placed),
      ada: await toldTo(fx.ada),
      outbox: await settledOf(fx.store),
      refused: await detailsOf("app.notification.refused", fx.app),
    }).toStrictEqual({
      answer: null,
      ada: [],
      outbox: [{ settled: true, undeliverable: "app.not_found" }],
      refused: [
        {
          appVersion: 1,
          principal: fx.bob.userId,
          via: "mutation",
          reason: "app.not_found",
        },
      ],
    });
  });

  it("tells nobody once its release is revoked", async () => {
    const fx = await fixture();
    const placed = await call(fx, fx.bob, "orders.place", {
      to: fx.ada.userId,
    });
    await env.DB.prepare(
      "UPDATE sdk_release_manifests SET revoked_at = ? WHERE app_id = ?"
    )
      .bind(Date.now(), fx.app)
      .run();
    await drain(fx);
    expect({
      answer: answerOf(placed),
      ada: await toldTo(fx.ada),
      outbox: await settledOf(fx.store),
    }).toStrictEqual({
      answer: null,
      ada: [],
      outbox: [{ settled: true, undeliverable: "version.revoked" }],
    });
  });

  it("tells nobody for an agent's call once the agent no longer holds its permission", async () => {
    const fx = await fixture();
    const answer = await dispatchAppNotifyIntent(
      env,
      entryOf(fx, fx.ada.userId, {
        agentId: "agent",
        workspaceId: workspaceIdSchema.parse(crypto.randomUUID()),
        chatId: chatIdSchema.parse(crypto.randomUUID()),
      })
    );
    expect({ answer, ada: await toldTo(fx.ada) }).toStrictEqual({
      answer: { undeliverable: "workflow.start_denied" },
      ada: [],
    });
  });

  it("tells once, and logs once, when the same entry is dispatched twice at once", async () => {
    const fx = await fixture();
    const entry = entryOf(fx, fx.ada.userId);
    const db = racingDb(async () => {
      await dispatchAppNotifyIntent(env, entry);
    }, /insert into "notifications"/iu);
    const answer = await dispatchAppNotifyIntent({ ...env, DB: db }, entry);
    expect({
      answer,
      ada: await titlesTo(fx.ada),
      sent: await countOf("app.notification.sent", fx.app),
    }).toStrictEqual({ answer: "delivered", ada: ["Dispatched"], sent: 1 });
  });

  it("refuses a visitor's send, so a visitor reaches no member", async () => {
    const fx = await fixture();
    const session = crypto.randomUUID();
    const invocation = await visitorInvocation(
      env,
      fx.release,
      {
        app: fx.app,
        version: 1,
        principal: `visitor:${session}`,
        email: "visitor@example.test",
        actor: { type: "visitor", appId: fx.app, sessionId: session },
        stillAllowed: async () => {},
        notGranted: async () => await Promise.reject(new Error("Not granted")),
        admitted: async () => {},
      },
      "orders.ping",
      crypto.randomUUID(),
      Date.now() + 30_000
    );
    const pinged = await callWith(invocation, "orders.ping", {
      to: fx.ada.userId,
    });
    await drain(fx);
    expect({
      answer: answerOf(pinged),
      told: await toldTo(fx.ada),
    }).toStrictEqual({ answer: "resource.unavailable", told: [] });
  });
});
