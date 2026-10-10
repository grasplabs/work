import type { AppCaller } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { KnowledgeApi } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callApp } from "../src/app.ts";
import type { AppCallerInput } from "../src/app.ts";
import { appHost } from "../src/durable-objects.ts";
import { sandbox } from "../src/sandbox.ts";
import { buildServer } from "../src/screens.ts";
import { outlook, release, requestGranted, serverBuilt } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { reached } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import {
  collectionWithNote,
  newTeam,
  readCollection,
  storedGrant,
} from "./knowledge.ts";
import { mailConnection } from "./mail-connection.ts";
import { auditedDuring, outcome, signedInApi } from "./sign-in.ts";

// An App's server code is written by the agent and runs for everyone who
// uses the App, so these tests take its side: code that tries to reach
// the network, the platform's bindings, another App or another person,
// and the host that has to stop it. The sample App runs for real, built
// from its committed version and loaded as a facet of its Durable Object.

const idp = mockIdp();

/** A signed-in person's API, on a connection of their own. */
const personApi = async (role: Role) => await signedInApi(idp, role);

/**
 * The sample App's server code. `LABEL` tells versions apart; module
 * state (`count`, `kept`) shows what a restart keeps, which is nothing.
 */
const serverCode = (
  label: string
) => `import { DurableObject, RpcTarget } from "cloudflare:workers";

import { outcome } from "./outcome.js";

type Caller = { userId: string; token: string };

const LABEL: string = "${label}";
let count = 0;
let kept: Caller | undefined;

export class App extends DurableObject {
  label(): string {
    return LABEL;
  }

  whoami(caller: Caller): string {
    return caller.userId;
  }

  count(): number {
    count += 1;
    return count;
  }

  remember(_caller: Caller, note: string): string[] {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notes (note TEXT)");
    this.ctx.storage.sql.exec("INSERT INTO notes VALUES (?)", note);
    return this.notes();
  }

  notes(): string[] {
    const tables = this.tables();
    if (!tables.includes("notes")) {
      return [];
    }
    return this.ctx.storage.sql
      .exec("SELECT note FROM notes")
      .toArray()
      .map((row) => String(row.note));
  }

  tables(): string[] {
    return this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => String(row.name))
      .filter((name) => !name.startsWith("_cf") && !name.startsWith("sqlite"));
  }

  envNames(): string[] {
    return Object.keys(this.env as object);
  }

  async importedEnv(): Promise<string[]> {
    const workers = await import("cloudflare:workers");
    return Object.keys((workers as { env?: object }).env ?? {});
  }

  async reachOut(): Promise<Record<string, string>> {
    return {
      fetch: await outcome(fetch("https://example.com/")),
      request: await outcome(fetch(new Request("http://10.0.0.1/"))),
      metadata: await outcome(fetch("http://169.254.169.254/latest/meta-data/")),
      loopback: await outcome(fetch("http://127.0.0.1:8787/")),
      ipv6: await outcome(fetch("http://[::1]/")),
      localhost: await outcome(fetch("http://localhost/")),
      cache: await outcome(caches.default.put("https://example.com/", new Response("x"))),
      cacheRead: await outcome(caches.default.match("https://example.com/")),
      cacheOpen: await outcome(caches.open("other").then((cache) => cache.put("https://example.com/", new Response("x")))),
      cacheOpenRead: await outcome(caches.open("other").then((cache) => cache.match("https://example.com/"))),
    };
  }

  async platform(): Promise<Record<string, unknown>> {
    const global = globalThis as Record<string, unknown>;
    const processEnv = (global.process as { env?: object } | undefined)?.env;
    return {
      fromStrings: [
        await outcome((async () => eval("import('cloudflare:sockets')"))()),
        await outcome((async () => new Function("return import('node:net')")())()),
      ],
      processEnv: Object.keys(processEnv ?? {}),
      require: typeof global.require,
      bindingsInGlobals: Object.keys(global).filter((name) => /^[A-Z][A-Z0-9_]+$/.test(name)),
    };
  }

  async writeLater(caller: Caller, wait: (caller: Caller) => Promise<void>, note: string): Promise<string> {
    await wait(caller);
    this.remember(caller, note);
    return await this.mail(caller);
  }

  async mail(caller: Caller, as?: unknown): Promise<string> {
    const outlook = (this.env as Record<string, any>).OUTLOOK;
    if (!outlook) {
      return "no binding";
    }
    return await outcome(outlook.call(as === undefined ? caller : as, "mail.list", {}));
  }

  async send(caller: Caller, key: string): Promise<string> {
    const mail = (this.env as Record<string, any>).MAIL;
    if (!mail) {
      return "no binding";
    }
    return await outcome(
      mail.call(caller, "mail.send", { to: "ben@acme.test", subject: "Hello" }, { idempotencyKey: key })
    );
  }

  async mailLater(caller: Caller, wait: (caller: Caller) => Promise<void>): Promise<string> {
    await wait(caller);
    return await this.mail(caller);
  }

  keep(caller: Caller): string {
    kept = caller;
    return "kept";
  }

  async mailAsKept(caller: Caller): Promise<string> {
    return await this.mail(caller, kept);
  }

  async reads(caller: Caller, binding: string, documentId: string, as?: unknown): Promise<string[]> {
    const collection = (this.env as Record<string, any>)[binding];
    if (!collection) {
      return ["no binding"];
    }
    const who = as === undefined ? caller : as;
    return await Promise.all([
      outcome(collection.listDocuments(who)),
      outcome(collection.getDocument(who, documentId)),
      outcome(collection.history(who, documentId)),
      outcome(collection.backlinks(who, documentId)),
      outcome(collection.search(who, "note")),
      outcome(collection.read(who, documentId, { section: 0 })),
      outcome(collection.follow(who, documentId)),
    ]);
  }

  async readWith(caller: Caller, binding: string, method: string, args: unknown[]): Promise<string> {
    const collection = (this.env as Record<string, any>)[binding];
    return await outcome(collection[method](caller, ...args));
  }

  async readLater(
    caller: Caller,
    wait: (caller: Caller) => Promise<void>,
    binding: string,
    documentId: string
  ): Promise<string[]> {
    await wait(caller);
    return await this.reads(caller, binding, documentId);
  }

  async readAsKept(caller: Caller, binding: string, documentId: string): Promise<string[]> {
    return await this.reads(caller, binding, documentId, kept);
  }

  async provenance(caller: Caller, binding: string, documentId: string): Promise<unknown> {
    const collection = (this.env as Record<string, any>)[binding];
    const { provenance } = await collection.getDocument(caller, documentId);
    return provenance;
  }

  fail(): never {
    throw new Error("Invoice 7 has no total");
  }

  failNamed(): never {
    const error = new Error("Named");
    error.name = "Invoice 7 for Acme";
    throw error;
  }

  giveFunction(): () => string {
    return () => "called back";
  }

  giveTarget(): RpcTarget {
    return new Invoices();
  }

  giveMap(): Map<string, number> {
    return new Map([["invoices", 7]]);
  }
}

class Invoices extends RpcTarget {
  count(): number {
    return 7;
  }
}
`;

/** Runs a promise and says how it ended, by error code; for App code. */
const outcomeCode = `export const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};
`;

const sampleFiles = (label: string): Record<string, string> => ({
  "app/server.ts": serverCode(label),
  "app/outcome.ts": outcomeCode,
  "screens/desk.tsx": "export default () => null;\n",
});

type Builder = Awaited<ReturnType<typeof personApi>>;

/**
 * A new App running the sample server code, built ahead (`serverBuilt`):
 * a test may start several at once, each within its first call's deadline.
 */
const sampleApp = async (builder: Builder, label = "v1"): Promise<AppId> => {
  const { id } = await builder.api.apps.create({ name: "Invoice desk" });
  await serverBuilt(id, await release(builder, id, sampleFiles(label)));
  return appIdSchema.parse(id);
};

const as = (userId: string): AppCallerInput => ({
  userId,
  mode: "interactive",
});

/** The caller a workflow run's host passes when a step calls its App. */
const inRun = (userId: string): AppCallerInput => ({
  userId,
  mode: "workflow",
  idempotencyKey: `${crypto.randomUUID()}:step`,
});

/** Gives the App `MAIL`, a mail connection to send on; an admin grants it. */
const grantMail = async (admin: Builder, app: string) => {
  const mail = await mailConnection();
  await requestGranted(idp, admin, {
    subject: { type: "app", appId: app },
    object: { type: "connection", connectionId: mail.id },
    actions: ["mail.send"],
    binding: "MAIL",
  });
  return mail;
};

/** The App's mail, sent for `userId` with a new idempotency key. */
const sendFor = async (app: AppId, userId: string): Promise<unknown> =>
  await callApp(env, app, as(userId), "send", [crypto.randomUUID()]);

/**
 * Whether each action held for `person` from `app` comes with the
 * restricted-data warning.
 */
const warningsFor = async (
  person: Builder,
  app: string
): Promise<boolean[]> => {
  const waiting = await person.api.pendingActions.list();
  return waiting
    .filter(({ context }) => context.type === "app" && context.appId === app)
    .map(({ restricted }) => restricted);
};

/** A side effect from a person using an App: held for them to confirm. */
const heldWrite = "ok";

/** The refusal of an import of `specifier`, as the build words it. */
const outsideKit = (specifier: string): string =>
  `"${specifier}" can't be imported here. Server code can import its own files in app/ and cloudflare:workers.`;

/** A Worker Loader that fails any load: proof that nothing was built. */
const noLoader: WorkerLoader = {
  get: () => {
    throw new Error("Nothing should be loaded");
  },
  load: () => {
    throw new Error("Nothing should be loaded");
  },
};

/** The module the socket test loads into the sandbox. */
interface SocketsProbe extends Rpc.WorkerEntrypointBranded {
  open: (address: string) => Promise<string>;
}

/** A promise to hold an App call at, and what the App passed while there. */
const gate = () => {
  const entered = Promise.withResolvers<AppCaller>();
  const released = Promise.withResolvers<boolean>();
  return {
    entered: entered.promise,
    release: () => {
      released.resolve(true);
    },
    wait: async (caller: AppCaller) => {
      entered.resolve(caller);
      await released.promise;
    },
  };
};

describe("App server code", { timeout: 60_000 }, () => {
  it("can't reach the network, by fetch or through a cache", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const reachOut = z
      .record(z.string(), z.string())
      .parse(await callApp(env, app, as(builder.userId), "reachOut"));
    const blocked = "not permitted to access the internet";
    const noCache = "No Cache was configured";
    const { cache, cacheRead, cacheOpen, cacheOpenRead, ...fetches } = reachOut;
    expect({
      fetches: Object.fromEntries(
        Object.entries(fetches).map(([name, ended]) => [
          name,
          ended.includes(blocked),
        ])
      ),
      caches: [cache, cacheRead, cacheOpen, cacheOpenRead].map(
        (ended) => ended?.includes(noCache) ?? false
      ),
    }).toStrictEqual({
      // The internet, the cloud's metadata address, a private network,
      // and the host itself, by name and by address.
      fetches: {
        fetch: true,
        request: true,
        metadata: true,
        loopback: true,
        ipv6: true,
        localhost: true,
      },
      // The default cache and one it names: workerd gives the sandbox
      // neither. This shows only that; what the platform's caches do for
      // a loaded Worker needs a real account to show.
      caches: [true, true, true, true],
    });
  });

  it("can't make code from strings, or find a secret or binding outside its env", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const evalRefused = "Code generation from strings disallowed";
    const platform = z
      .object({
        fromStrings: z.array(z.string()),
        processEnv: z.array(z.string()),
        require: z.string(),
        bindingsInGlobals: z.array(z.string()),
      })
      .parse(await callApp(env, app, as(builder.userId), "platform"));
    expect({
      ...platform,
      // `eval` and `new Function` would import what the build refuses
      // (`cloudflare:sockets`, `node:net`).
      fromStrings: platform.fromStrings.map((ended) =>
        ended.includes(evalRefused)
      ),
    }).toStrictEqual({
      fromStrings: [true, true],
      processEnv: [],
      require: "undefined",
      bindingsInGlobals: [],
    });
  });

  it("has only its own granted connections in its env, never core's bindings", async () => {
    const admin = await personApi("admin");
    const app = await sampleApp(admin);
    await requestGranted(idp, admin, outlook(app));
    await admin.api.permissions.request(outlook(app, "ASKED"));
    await admin.api.permissions.revoke(
      await requestGranted(idp, admin, outlook(app, "GONE"))
    );
    const other = await sampleApp(admin);
    await requestGranted(idp, admin, outlook(other, "SOMEONE_ELSES"));

    const [envNames, importedEnv] = await Promise.all([
      callApp(env, app, as(admin.userId), "envNames"),
      callApp(env, app, as(admin.userId), "importedEnv"),
    ]);
    expect({ envNames, importedEnv }).toStrictEqual({
      // And its statistics, which every App has.
      envNames: ["OUTLOOK", "STATISTICS"],
      importedEnv: [],
    });
  });

  it("can't read another App's data, or its host's", async () => {
    const builder = await personApi("builder");
    const [mine, theirs] = await Promise.all([
      sampleApp(builder),
      sampleApp(builder),
    ]);
    await callApp(env, theirs, as(builder.userId), "remember", ["secret"]);
    await callApp(env, mine, as(builder.userId), "remember", ["mine"]);
    await runInDurableObject(appHost(env, mine), (_host, state) => {
      state.storage.sql.exec("CREATE TABLE host_secrets (secret TEXT)");
    });

    const [notes, tables] = await Promise.all([
      callApp(env, mine, as(builder.userId), "notes"),
      callApp(env, mine, as(builder.userId), "tables"),
    ]);
    expect({ notes, tables }).toStrictEqual({
      notes: ["mine"],
      tables: ["notes"],
    });
  });

  it("shares no memory with another App running the same code", async () => {
    const builder = await personApi("builder");
    const [one, two] = await Promise.all([
      sampleApp(builder),
      sampleApp(builder),
    ]);
    const counts = [
      await callApp(env, one, as(builder.userId), "count"),
      await callApp(env, one, as(builder.userId), "count"),
      await callApp(env, two, as(builder.userId), "count"),
    ];
    expect(counts).toStrictEqual([1, 2, 1]);
  });

  it("acts for each caller of the App, when two people use it at once", async () => {
    const admin = await personApi("admin");
    const stays = await personApi("user");
    const leaves = await personApi("user");
    const app = await sampleApp(admin);
    await requestGranted(idp, admin, outlook(app));
    // Someone who left can't use the App's connections any more: that is
    // how these calls show whom they act for.
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(leaves.userId)
      .run();
    await callApp(env, app, as(stays.userId), "label");

    // Each holds the App while the other one calls, which waits its turn,
    // in both orders.
    const first = gate();
    const staysFirst = callApp(env, app, as(stays.userId), "mailLater", [
      first.wait,
    ]);
    await first.entered;
    const leavesMeanwhile = callApp(env, app, as(leaves.userId), "mail");
    first.release();

    const second = gate();
    const leavesFirst = callApp(env, app, as(leaves.userId), "mailLater", [
      second.wait,
    ]);
    await second.entered;
    const staysMeanwhile = callApp(env, app, as(stays.userId), "mail");
    second.release();

    const whoami = await Promise.all([
      callApp(env, app, as(stays.userId), "whoami"),
      callApp(env, app, as(leaves.userId), "whoami"),
    ]);
    expect({
      stays: [await staysFirst, await staysMeanwhile],
      leaves: [await leavesMeanwhile, await leavesFirst],
      whoami,
    }).toStrictEqual({
      stays: [reached, reached],
      leaves: ["permission.person_inactive", "permission.person_inactive"],
      whoami: [stays.userId, leaves.userId],
    });
  });

  it("can't make up a caller, or use one after its call ended", async () => {
    const admin = await personApi("admin");
    const app = await sampleApp(admin);
    await requestGranted(idp, admin, outlook(app));
    const caller = as(admin.userId);

    const madeUp = await Promise.all(
      [
        { userId: admin.userId, token: crypto.randomUUID() },
        { userId: admin.userId },
        admin.userId,
        null,
      ].map(async (forged) => await callApp(env, app, caller, "mail", [forged]))
    );
    await callApp(env, app, caller, "keep");
    const afterItEnded = await callApp(env, app, caller, "mailAsKept");
    expect({ madeUp, afterItEnded }).toStrictEqual({
      madeUp: [
        "app.caller_invalid",
        "app.caller_invalid",
        "app.caller_invalid",
        "app.caller_invalid",
      ],
      afterItEnded: "app.caller_invalid",
    });
  });

  it("can't act with a caller of another App", async () => {
    const admin = await personApi("admin");
    const [mine, theirs] = await Promise.all([
      sampleApp(admin),
      sampleApp(admin),
    ]);
    await requestGranted(idp, admin, outlook(mine));
    await requestGranted(idp, admin, outlook(theirs));
    await Promise.all([
      callApp(env, mine, as(admin.userId), "label"),
      callApp(env, theirs, as(admin.userId), "label"),
    ]);

    const held = gate();
    const theirCall = callApp(env, theirs, as(admin.userId), "mailLater", [
      held.wait,
    ]);
    const theirCaller = await held.entered;
    const withTheirCaller = await callApp(env, mine, as(admin.userId), "mail", [
      theirCaller,
    ]);
    held.release();
    expect({
      withTheirCaller,
      theirOwn: await theirCall,
    }).toStrictEqual({
      withTheirCaller: "app.caller_invalid",
      theirOwn: reached,
    });
  });

  it("loses a revoked connection at once, and gets a new grant without a release", async () => {
    const admin = await personApi("admin");
    const app = await sampleApp(admin);
    const caller = as(admin.userId);
    const permission = await requestGranted(idp, admin, outlook(app));
    const whileGranted = await callApp(env, app, caller, "mail");

    await admin.api.permissions.revoke(permission);
    const afterRevoke = await Promise.all([
      callApp(env, app, caller, "mail"),
      callApp(env, app, caller, "envNames"),
    ]);
    await requestGranted(idp, admin, outlook(app, "OUTLOOK"));
    const afterNewGrant = await callApp(env, app, caller, "mail");
    expect({ whileGranted, afterRevoke, afterNewGrant }).toStrictEqual({
      whileGranted: reached,
      afterRevoke: ["no binding", ["STATISTICS"]],
      afterNewGrant: reached,
    });
  });

  it("is audited with the version whose code made each connection call", async () => {
    const admin = await personApi("admin");
    const app = await sampleApp(admin, "v1");
    await requestGranted(idp, admin, outlook(app));
    /** The versions on the App's connection calls in the log, once `count` are. */
    const auditedVersions = async (count: number) =>
      await vi.waitFor(async () => {
        const events = await allEvents();
        const calls = events.filter(
          ({ action, actor }) =>
            action === "connection.call" &&
            actor.type === "app" &&
            actor.appId === app
        );
        if (calls.length < count) {
          throw new Error("Not every call is in the audit log yet");
        }
        return calls.map(({ detail }) => detail.appVersion);
      }, 10_000);

    await callApp(env, app, as(admin.userId), "mail");
    const beforeRelease = await auditedVersions(1);
    await release(admin, app, { "app/server.ts": serverCode("v2") });
    await callApp(env, app, as(admin.userId), "mail");
    // A workflow run's call into the App, with its step's key.
    await callApp(
      env,
      app,
      { userId: admin.userId, mode: "workflow", idempotencyKey: "run:step" },
      "mail"
    );
    expect({
      beforeRelease,
      afterRelease: await auditedVersions(3),
    }).toStrictEqual({ beforeRelease: [1], afterRelease: [1, 2, 2] });
  });

  it("still reads, and holds its actions with a restricted-data warning, once it is in restricted mode", async () => {
    const admin = await personApi("admin");
    const app = await sampleApp(admin);
    await requestGranted(idp, admin, outlook(app));
    const mail = await grantMail(admin, app);
    const caller = as(admin.userId);
    const calls = async () => [
      await callApp(env, app, caller, "mail"),
      await sendFor(app, admin.userId),
    ];
    const before = await calls();
    await appHost(env, app).restrict();
    const after = await calls();
    expect({
      before,
      after,
      warned: await warningsFor(admin, app),
      server: await mail.did(),
    }).toStrictEqual({
      before: [reached, heldWrite],
      after: [reached, heldWrite],
      // The one held before and the one after: both would now send from
      // an App that read restricted data.
      warned: [true, true],
      server: { calls: 0, sent: [] },
    });
  });

  it("keeps its data across restarts and versions, and nothing else", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder, "v1");
    const caller = as(builder.userId);
    await callApp(env, app, caller, "remember", ["before"]);
    await callApp(env, app, caller, "count");

    await appHost(env, app).restart("A test restarts it.");
    const afterRestart = {
      notes: await callApp(env, app, caller, "remember", ["restarted"]),
      count: await callApp(env, app, caller, "count"),
    };

    await release(builder, app, { "app/server.ts": serverCode("v2") });
    const afterRelease = {
      label: await callApp(env, app, caller, "label"),
      notes: await callApp(env, app, caller, "remember", ["released"]),
      count: await callApp(env, app, caller, "count"),
    };

    await builder.api.apps.versions.setCurrent(app, 1);
    const afterRollback = {
      label: await callApp(env, app, caller, "label"),
      count: await callApp(env, app, caller, "count"),
    };
    expect({ afterRestart, afterRelease, afterRollback }).toStrictEqual({
      afterRestart: { notes: ["before", "restarted"], count: 1 },
      afterRelease: {
        label: "v2",
        notes: ["before", "restarted", "released"],
        count: 1,
      },
      afterRollback: { label: "v1", count: 1 },
    });
  });

  it("can't keep acting or writing by holding a call open past its time", async () => {
    const admin = await personApi("admin");
    const app = await sampleApp(admin);
    await requestGranted(idp, admin, outlook(app));
    const caller = as(admin.userId);
    // Module state the code holds before: none of it is there after.
    const countBefore = await callApp(env, app, caller, "count");

    // A busy loop ends at the CPU limit, which the platform enforces and
    // workerd doesn't; a call that waits too long is given up on, and the
    // App's code it waits in is stopped.
    const late = gate();
    const lateCall = outcome(
      callApp(env, app, caller, "writeLater", [late.wait, "late"])
    );
    await late.entered;
    const timedOut = await lateCall;

    // A call after it runs on code started afresh. Both are let go at
    // once: what the first would write and mail, the second does.
    const after = gate();
    const afterCall = callApp(env, app, caller, "writeLater", [
      after.wait,
      "after",
    ]);
    await after.entered;
    late.release();
    after.release();
    const afterAnswer = await afterCall;
    expect({
      timedOut,
      afterAnswer,
      notes: await callApp(env, app, caller, "notes"),
      counts: [countBefore, await callApp(env, app, caller, "count")],
    }).toStrictEqual({
      timedOut: "app.timed_out",
      afterAnswer: reached,
      notes: ["after"],
      // A new isolate: the count starts again.
      counts: [1, 1],
    });
  });

  it("runs a call through an export only on the code it was pinned to, not the same version restarted", async () => {
    const admin = await personApi("admin");
    const app = await sampleApp(admin);
    const caller = as(admin.userId);
    await callApp(env, app, caller, "label");

    // As the call is recorded, the App's code is restarted, on the same
    // version. No other call can start it again meanwhile: it waits for
    // this one's turn to end.
    const pinned = await outcome(
      appHost(env, app).call(caller, "remember", ["pinned"], {
        version: 1,
        chain: [],
        deadline: Date.now() + 10_000,
        readOnly: false,
        onPinned: async () => {
          await appHost(env, app).restart("A test restarts it.");
        },
      })
    );
    expect({
      pinned,
      notes: await callApp(env, app, caller, "notes"),
    }).toStrictEqual({ pinned: "app.conflict", notes: [] });
  });

  it("can't be stopped by another App calling it just before its own call ends", async () => {
    const admin = await personApi("admin");
    const app = await sampleApp(admin);
    await requestGranted(idp, admin, outlook(app));
    const caller = as(admin.userId);
    // Module state the code holds before: still there after, as the code
    // goes on.
    const countBefore = await callApp(env, app, caller, "count");

    // A call through an export, as app-calls.ts makes it, from a call that
    // has a moment left: it ends at that call's deadline, long before the
    // App's own time for a call. Its deadline's timer is held until its
    // method has started, however slow the runner is, then let go.
    const cutShort = gate();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let cutShortEnded: string;
    let countAfter: unknown;
    try {
      const cutShortCall = outcome(
        appHost(env, app).call(caller, "writeLater", [cutShort.wait, "short"], {
          version: 1,
          chain: [],
          deadline: Date.now() + 5000,
          readOnly: false,
          onPinned: async () => {},
        })
      );
      await cutShort.entered;
      // In the App's object, whose timer it is.
      await runInDurableObject(appHost(env, app), async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      cutShortEnded = await cutShortCall;
      // The next call waits for the cut-off code to settle, then runs in
      // the same code, which wasn't stopped.
      const counting = callApp(env, app, caller, "count");
      cutShort.release();
      countAfter = await counting;
    } finally {
      vi.useRealTimers();
      cutShort.release();
    }
    expect({
      cutShort: cutShortEnded,
      counts: [countBefore, countAfter],
    }).toStrictEqual({ cutShort: "app.timed_out", counts: [1, 2] });
  });

  it("reports its errors with the version, and logs none of their text", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    // What the App's host writes to Workers Logs while the call fails.
    const logged = vi.spyOn(console, "warn");
    let failed: unknown;
    let logs: string;
    try {
      failed = await callApp(env, app, as(builder.userId), "fail").then(
        () => {},
        (error: unknown) => error
      );
      await outcome(callApp(env, app, as(builder.userId), "failNamed"));
      logs = JSON.stringify(logged.mock.calls);
    } finally {
      logged.mockRestore();
    }
    expect({
      failed,
      logsTheCall: logs.includes("app.call_failed"),
      logsTheText: logs.includes("Invoice 7"),
    }).toMatchObject({
      failed: {
        code: "app.failed",
        details: {
          version: 1,
          method: "fail",
          message: "Invoice 7 has no total",
        },
      },
      logsTheCall: true,
      logsTheText: false,
    });
  });

  it("answers plain data only, never a way back into the App", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const answers = await Promise.all(
      ["giveFunction", "giveTarget", "giveMap"].map(
        async (method) =>
          await outcome(callApp(env, app, as(builder.userId), method))
      )
    );
    expect(answers).toStrictEqual([
      "app.answer_invalid",
      "app.answer_invalid",
      "ok",
    ]);
  });

  it("tells its callers nothing of what fails outside the App", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    // Arguments RPC can't carry fail on the way in.
    const failed = await callApp(env, app, as(builder.userId), "label", [
      Symbol("not data"),
    ]).then(
      () => {},
      (error: unknown) => error
    );
    expect(failed).toMatchObject({
      code: "internal.unexpected",
      message: "Something went wrong.",
    });
  });

  it("answers only the methods the App exports", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const refused = await Promise.all(
      [
        "fetch",
        "alarm",
        "constructor",
        "__proto__",
        "then",
        "",
        "a.b",
        "toString",
        "hasOwnProperty",
        "propertyIsEnumerable",
        "toLocaleString",
        "valueOf",
        "connect",
        "get",
        "put",
        "delete",
        "queue",
        "scheduled",
        "id",
        "name",
      ].map(
        async (method) =>
          await outcome(callApp(env, app, as(builder.userId), method))
      )
    );
    expect(refused).toStrictEqual(refused.map(() => "app.method_invalid"));
  });

  it("can't open a socket, to the internet or to the host", async () => {
    // What the App's server build refuses to import, loaded as the sandbox
    // loads App code: `connect()` has no way out either.
    const sockets = env.LOADER.get("sandbox-sockets-test", () => ({
      ...sandbox,
      mainModule: "sockets.js",
      modules: {
        "sockets.js": `import { WorkerEntrypoint } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";

export default class extends WorkerEntrypoint {
  async open(address) {
    try {
      const socket = connect(address);
      await socket.opened;
      return "open";
    } catch (error) {
      return String(error);
    }
  }
}
`,
      },
      env: {},
    }));
    const entrypoint = sockets.getEntrypoint<SocketsProbe>();
    const opened = await Promise.all(
      ["1.1.1.1:443", "example.com:80", "127.0.0.1:8787", "localhost:80"].map(
        async (address) => await entrypoint.open(address)
      )
    );
    expect(
      opened.map((result) =>
        result.includes("not permitted to access the internet")
      )
    ).toStrictEqual([true, true, true, true]);
  });

  it("can't import a module that reaches past its env, however it names it", async () => {
    // Each loaded by the App's server code, as a file of its own.
    const reachesOut = {
      sockets:
        'import { connect } from "cloudflare:sockets";\nexport const open = connect;\n',
      net: 'import net from "node:net";\nexport default net;\n',
      processes: 'export { spawn } from "node:child_process";\n',
      email: 'export { EmailMessage } from "cloudflare:email";\n',
      named:
        "export const load = async (name: string) => await import(name);\n",
      required: 'export const net = require("node:net");\n',
    };
    const builds = await Promise.all(
      Object.values(reachesOut).map(
        async (probe) =>
          await buildServer(env, {
            "app/server.ts":
              'export * from "./probe.ts";\nexport class App {}\n',
            "app/probe.ts": probe,
          })
      )
    );
    expect(
      builds.map((build) =>
        build.ok
          ? "built"
          : build.diagnostics.map(({ file, message }) => ({ file, message }))
      )
    ).toStrictEqual(
      [
        outsideKit("cloudflare:sockets"),
        outsideKit("node:net"),
        outsideKit("node:child_process"),
        outsideKit("cloudflare:email"),
        "import() must name a module in quotes.",
        "require() isn't available in server code: use import.",
      ].map((message) => [{ file: "app/probe.ts", message }])
    );
  });

  it("is inspected without running any of its code in core, or reaching out as it is", async () => {
    const builder = await personApi("builder");
    const { id } = await builder.api.apps.create({ name: "Inspected" });
    // As each module loads: a mark on the global scope it runs in, and a
    // try at the network, whose outcome the workflow's parameter shows.
    const marks = `const global = globalThis as Record<string, unknown>;
global.graspInspected = true;
`;
    const files = {
      "app/server.ts": `${marks}export class App {}\n`,
      "workflows/probe.ts": `import { text, workflow, z } from "@grasp-os/sdk/workflow";

${marks}const reached = await fetch("https://example.com/").then(
  () => "reached",
  (error: unknown) => String(error).slice(0, 150)
);

export default workflow(
  "probe",
  { input: z.unknown(), params: { reached: text({ label: reached, default: "" }) } },
  async (step) => await step.do("one", { description: "One" }, async () => 1)
);
`,
      "workflows/probe.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./probe.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { one: 1 }, expect: { output: 1 } }]);
`,
    };
    Reflect.deleteProperty(globalThis, "graspInspected");
    // Built, its workflows' tests run, and their parameters read.
    await serverBuilt(id, await release(builder, id, files));
    const params = await builder.api.workflows.params.list(id, "probe");
    expect({
      inCore: Object.hasOwn(globalThis, "graspInspected"),
      // It ran, in an isolate of its own, and was refused I/O as its
      // module loaded.
      reached: params.map(({ label }) =>
        label.includes("Disallowed operation called within global scope")
      ),
    }).toStrictEqual({ inCore: false, reached: [true] });
  });

  it("runs nothing without a current version that builds, and builds it once", async () => {
    const builder = await personApi("builder");
    const { id } = await builder.api.apps.create({ name: "Empty" });
    const empty = appIdSchema.parse(id);
    const noVersion = await outcome(
      callApp(env, empty, as(builder.userId), "label")
    );
    const broken = {
      "app/server.ts":
        'import { readFileSync } from "node:fs";\nimport "./legacy.js";\nimport "./lazy.js";\nexport class App {}\n',
      "app/legacy.ts": 'export const fs = require("node:fs");\n',
      "app/lazy.ts":
        'export const load = async () => await import("node:fs");\n',
    };
    await release(builder, empty, broken);
    const brokenBuild = await callApp(
      env,
      empty,
      as(builder.userId),
      "label"
    ).then(
      () => {},
      (error: unknown) => error
    );
    // The same files fail the same way: from the cache, without a compiler.
    const again = await buildServer({ ...env, LOADER: noLoader }, broken);
    const unknownApp = await outcome(
      callApp(
        env,
        appIdSchema.parse("no-such-app"),
        as(builder.userId),
        "label"
      )
    );
    expect({
      noVersion,
      brokenBuild,
      again: again.ok,
      unknownApp,
    }).toMatchObject({
      noVersion: "app.not_running",
      brokenBuild: {
        code: "app.build_failed",
        details: {
          version: 1,
          diagnostics: [
            { file: "app/lazy.ts", line: 1 },
            { file: "app/legacy.ts" },
            { file: "app/server.ts", line: 1 },
          ],
        },
      },
      again: false,
      unknownApp: "app.not_found",
    });
  });
});

/** Someone's Knowledge, as they reach it in the product. */
const knowledgeOf = (person: Builder): { knowledge: KnowledgeApi } => {
  const knowledge: KnowledgeApi = person.api.knowledge;
  return { knowledge };
};

/** What each of the sample App's reads (`reads`) ended with. */
const everyReadIs = (code: string) => Array.from({ length: 7 }, () => code);

// The same App serves everyone, so what it reads from Knowledge must be
// what the person whose call it runs in may read, and no more (R5): the
// App's grant intersected with that person's access, never a personal
// collection (those never enter a shared context), and never for someone
// App code names itself (R3, SB4). A sensitive read restricts the App for
// good, before the data reaches its code (Q12).
describe("App server code reading Knowledge", { timeout: 60_000 }, () => {
  /**
   * An App granted a team's collection (`HANDBOOK`), a member of the team
   * and someone outside it, and a collection the App wasn't granted.
   */
  const setUp = async () => {
    const admin = await personApi("admin");
    const member = await personApi("user");
    const outsider = await personApi("user");
    const teamId = await newTeam(admin, [member]);
    const [finance, other] = await Promise.all([
      collectionWithNote(knowledgeOf(admin), {
        name: "Finance",
        access: "teams",
        teams: [teamId],
      }),
      collectionWithNote(knowledgeOf(admin), {
        name: "Other",
        access: "everyone",
      }),
    ]);
    const app = await sampleApp(admin);
    const permission = await requestGranted(
      idp,
      admin,
      readCollection({ type: "app", appId: app }, finance.collectionId)
    );
    return { admin, member, outsider, app, permission, finance, other };
  };

  it("reads a granted collection for the calling person, and nothing they or it can't read", async () => {
    const { admin, member, outsider, app, permission, finance, other } =
      await setUp();
    const readsAs = async (userId: string, noteId = finance.noteId) =>
      await callApp(env, app, as(userId), "reads", ["HANDBOOK", noteId]);

    expect({
      envNames: await callApp(env, app, as(member.userId), "envNames"),
      member: await readsAs(member.userId),
      // The App's grant alone isn't enough.
      outsider: await readsAs(outsider.userId),
      // Only its own collection, also for someone who can read another.
      other: await readsAs(member.userId, other.noteId),
    }).toStrictEqual({
      envNames: ["HANDBOOK", "STATISTICS"],
      member: everyReadIs("ok"),
      outsider: everyReadIs("knowledge.not_found"),
      other: [
        "ok",
        "knowledge.not_found",
        "knowledge.not_found",
        "knowledge.not_found",
        "ok",
        "knowledge.not_found",
        "knowledge.not_found",
      ],
    });

    await admin.api.permissions.revoke(permission);
    await expect(readsAs(member.userId)).resolves.toStrictEqual(["no binding"]);
  });

  it("reads nothing for someone who has left", async () => {
    const { member, app, finance } = await setUp();
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(member.userId)
      .run();
    await expect(
      callApp(env, app, as(member.userId), "reads", [
        "HANDBOOK",
        finance.noteId,
      ])
    ).resolves.toStrictEqual(everyReadIs("permission.person_inactive"));
  });

  it("reads for each caller of the App, when two people read at once", async () => {
    const { member, outsider, app, finance } = await setUp();
    await callApp(env, app, as(member.userId), "label");
    const readArgs = ["HANDBOOK", finance.noteId];

    // Each holds the App while the other one reads, which waits its turn,
    // in both orders.
    const first = gate();
    const memberFirst = callApp(env, app, as(member.userId), "readLater", [
      first.wait,
      ...readArgs,
    ]);
    await first.entered;
    const outsiderMeanwhile = callApp(
      env,
      app,
      as(outsider.userId),
      "reads",
      readArgs
    );
    first.release();

    const second = gate();
    const outsiderFirst = callApp(env, app, as(outsider.userId), "readLater", [
      second.wait,
      ...readArgs,
    ]);
    await second.entered;
    const memberMeanwhile = callApp(
      env,
      app,
      as(member.userId),
      "reads",
      readArgs
    );
    second.release();

    expect({
      member: [await memberFirst, await memberMeanwhile],
      outsider: [await outsiderMeanwhile, await outsiderFirst],
    }).toStrictEqual({
      member: [everyReadIs("ok"), everyReadIs("ok")],
      outsider: [
        everyReadIs("knowledge.not_found"),
        everyReadIs("knowledge.not_found"),
      ],
    });
  });

  it("can't read with a made-up caller, one whose call ended, or another App's", async () => {
    const { admin, member, app, finance } = await setUp();
    const theirs = await sampleApp(admin);
    await requestGranted(
      idp,
      admin,
      readCollection({ type: "app", appId: theirs }, finance.collectionId)
    );
    const caller = as(member.userId);
    const readArgs = ["HANDBOOK", finance.noteId];

    const madeUp = await Promise.all(
      [
        { userId: member.userId, token: crypto.randomUUID() },
        { userId: member.userId },
        member.userId,
        null,
      ].map(
        async (forged) =>
          await callApp(env, app, caller, "reads", [...readArgs, forged])
      )
    );
    await callApp(env, app, caller, "keep");
    const afterItEnded = await callApp(
      env,
      app,
      caller,
      "readAsKept",
      readArgs
    );

    const held = gate();
    const theirCall = callApp(env, theirs, caller, "readLater", [
      held.wait,
      ...readArgs,
    ]);
    const theirCaller = await held.entered;
    const withTheirCaller = await callApp(env, app, caller, "reads", [
      ...readArgs,
      theirCaller,
    ]);
    held.release();
    expect({
      madeUp,
      afterItEnded,
      withTheirCaller,
      theirOwn: await theirCall,
    }).toStrictEqual({
      madeUp: Array.from({ length: 4 }, () =>
        everyReadIs("app.caller_invalid")
      ),
      afterItEnded: everyReadIs("app.caller_invalid"),
      withTheirCaller: everyReadIs("app.caller_invalid"),
      theirOwn: everyReadIs("ok"),
    });
  });

  it("records each read in the audit log as the App's", async () => {
    const { member, app, finance } = await setUp();
    const events = await auditedDuring(async () => {
      await callApp(env, app, as(member.userId), "readWith", [
        "HANDBOOK",
        "read",
        [finance.noteId, { section: 0 }],
      ]);
    });
    expect(
      events
        .filter(({ action }) => action === "knowledge.read")
        .map(({ actor, target, provenance, detail }) => ({
          actor,
          target,
          provenance,
          detail,
        }))
    ).toStrictEqual([
      {
        actor: { type: "app", appId: app, part: "server" },
        target: { type: "document", id: finance.noteId },
        provenance: [finance.collectionId],
        detail: { read: "section", version: 1, section: 0, sensitive: false },
      },
    ]);
  });

  it("never reads a personal collection, not even for its owner", async () => {
    const owner = await personApi("user");
    const diary = await collectionWithNote(knowledgeOf(owner), {
      name: "Diary",
      access: "me",
    });
    const app = await sampleApp(await personApi("builder"));
    // Nobody can grant one; a grant that exists anyway reads nothing.
    await storedGrant(
      { type: "app", id: app },
      { type: "collection", id: diary.collectionId },
      ["read"],
      "DIARY"
    );
    await expect(
      callApp(env, app, as(owner.userId), "reads", ["DIARY", diary.noteId])
    ).resolves.toStrictEqual(everyReadIs("knowledge.not_found"));
  });

  it("is restricted for good by a sensitive read, and then holds every action for the person it acts for", async () => {
    const admin = await personApi("admin");
    const outsider = await personApi("user");
    const teamId = await newTeam(admin, []);
    const [payroll, handbook] = await Promise.all([
      collectionWithNote(knowledgeOf(admin), {
        name: "Payroll",
        access: "teams",
        teams: [teamId],
        sensitive: true,
      }),
      collectionWithNote(knowledgeOf(admin), {
        name: "Handbook",
        access: "everyone",
      }),
    ]);
    const app = await sampleApp(admin);
    const subject = { type: "app" as const, appId: app };
    const mail = await grantMail(admin, app);
    await requestGranted(
      idp,
      admin,
      readCollection(subject, payroll.collectionId)
    );
    await requestGranted(
      idp,
      admin,
      readCollection(subject, handbook.collectionId, "OTHER")
    );
    const send = async (userId: string) => await sendFor(app, userId);

    // Ordinary reads, and a sensitive read that was refused, change nothing.
    const ordinary = await callApp(env, app, as(admin.userId), "provenance", [
      "OTHER",
      handbook.noteId,
    ]);
    const refused = await callApp(env, app, as(outsider.userId), "reads", [
      "HANDBOOK",
      payroll.noteId,
    ]);
    const before = await send(admin.userId);

    const sensitive = await callApp(env, app, as(admin.userId), "provenance", [
      "HANDBOOK",
      payroll.noteId,
    ]);
    await appHost(env, app).restart("A test restarts it.");
    expect({
      server: await mail.did(),
      ordinary,
      refused,
      before,
      sensitive,
      after: [await send(admin.userId), await send(outsider.userId)],
      // Knowledge stays inside the deployment, so it can still be read.
      stillReads: await callApp(env, app, as(admin.userId), "reads", [
        "OTHER",
        handbook.noteId,
      ]),
    }).toStrictEqual({
      server: { calls: 0, sent: [] },
      ordinary: {
        collectionIds: [handbook.collectionId],
        sensitive: false,
        restricted: false,
      },
      refused: everyReadIs("knowledge.not_found"),
      before: heldWrite,
      sensitive: {
        collectionIds: [payroll.collectionId],
        sensitive: true,
        restricted: true,
      },
      after: [heldWrite, heldWrite],
      stillReads: everyReadIs("ok"),
    });
    expect({
      admin: await warningsFor(admin, app),
      outsider: await warningsFor(outsider, app),
    }).toStrictEqual({ admin: [true, true], outsider: [true] });
  });

  it("is restricted by every read that reaches a sensitive collection, also one that finds nothing", async () => {
    const admin = await personApi("admin");
    const teamId = await newTeam(admin, []);
    const payroll = await collectionWithNote(knowledgeOf(admin), {
      name: "Payroll",
      access: "teams",
      teams: [teamId],
      sensitive: true,
    });
    // A search that misses, or a version that isn't there, still tells App
    // code something of the collection, so it could probe it candidate by
    // candidate and send out what it learned.
    const reads: [method: string, args: unknown[]][] = [
      ["listDocuments", []],
      ["history", [payroll.noteId]],
      ["backlinks", [payroll.noteId]],
      ["search", ["note"]],
      ["search", ["zzzqqqxxx"]],
      ["search", [""]],
      ["getDocument", [payroll.noteId, 99]],
    ];
    const results = await Promise.all(
      reads.map(async ([method, args]) => {
        const app = await sampleApp(admin);
        await requestGranted(
          idp,
          admin,
          readCollection({ type: "app", appId: app }, payroll.collectionId)
        );
        const read = await callApp(env, app, as(admin.userId), "readWith", [
          "HANDBOOK",
          method,
          args,
        ]);
        return [read, await appHost(env, app).isRestricted()];
      })
    );
    expect(results).toStrictEqual([
      ["ok", true],
      ["ok", true],
      ["ok", true],
      ["ok", true],
      ["ok", true],
      ["ok", true],
      ["knowledge.not_found", true],
    ]);
  });

  it("reads for the person a workflow run acts for, when the run calls it", async () => {
    const { member, outsider, app, finance } = await setUp();
    const readArgs = ["HANDBOOK", finance.noteId];
    expect({
      member: await callApp(env, app, inRun(member.userId), "reads", readArgs),
      outsider: await callApp(
        env,
        app,
        inRun(outsider.userId),
        "reads",
        readArgs
      ),
    }).toStrictEqual({
      member: everyReadIs("ok"),
      outsider: everyReadIs("knowledge.not_found"),
    });
  });
});
