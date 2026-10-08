import { appErrorDetailsBytes } from "@grasp-os/shared/apps";
import {
  appIdSchema,
  collectionIdSchema,
  permissionIdSchema,
} from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { AppConnectionBinding } from "../src/app-bindings.ts";
import { callApp } from "../src/app.ts";
import { AppGuestsBinding } from "../src/guests-binding.ts";
import { AppCollectionBinding } from "../src/knowledge/app-binding.ts";
import { ordinaryData, release, requestGranted, serverBuilt } from "./apps.ts";
import { reached } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { mailConnection, mailWithSearch } from "./mail-connection.ts";
import type { MailAnswer } from "./mail-server.ts";
import { finished } from "./runs.ts";
import { callAuth, outcome, signedInApi, unique } from "./sign-in.ts";
import { workflowFiles } from "./workflow-apps.ts";

// Every call into an App runs as an invocation the host makes as the
// call starts (app.ts): who it acts for, on which version, until when, and
// what it may do, from what core knows of the call (the session, the run,
// or the export core checked), never from what App code or a page passes.
// Each stub call of the App's code is admitted against it. These tests
// start from how that can fail:
//
// - a call through an export marked `read` changes something after all,
//   through any of its stubs: a connection's side effect (connect knows
//   which actions change things; core doesn't), a record saved, a
//   statistics point recorded, or another App's export marked `write`;
// - App code dresses its caller up as a writer, or as someone else, to
//   get past that: only the token counts;
// - a call's arguments or answer carry what no public value may (a big
//   integer), or its error carries more of the App's text to a screen
//   than an error may;
// - a call keeps acting after what let it in is gone, while its code
//   still runs: the person's role in the App (a team left, which
//   restarts nothing), or the calling App's permission on the export;
// - a call keeps acting once its App's code was restarted under it;
// - a stub call that awaits after it was admitted (a permission check,
//   signing, a lookup) acts on what let it in as it was then: the
//   person's role, or a permission up a chain of Apps, gone while it
//   awaited, still lets a connection call reach connect, a guest be
//   invited or a guest chat be revoked.
//
// Every App here runs for real, in its own sandbox; calls go in through
// the host as screens, workflows and other Apps make them.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

type Person = Awaited<ReturnType<typeof personApi>>;

/**
 * The App's server code: `everything` tries each stub that reads or
 * changes something, for its caller or for whatever `as` passes instead,
 * and says how each ended; `lookUp` (exported as a read) and `change`
 * (exported as a write) run it. `via` calls another App's export, as a
 * screen of the calling App would have it.
 */
const server = `import { DurableObject } from "cloudflare:workers";

type Caller = { userId: string; token: string };
type Stub = Record<string, (...args: unknown[]) => Promise<unknown>>;

const tried = async (call: () => Promise<unknown>): Promise<unknown> => {
  try {
    const answer = await call();
    return typeof answer === "boolean" ? answer : "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? "failed";
  }
};

// Each way a value can carry a big integer past a walk of its members.
const carrying = (shape: string): unknown => {
  const boxed = Object(7n);
  switch (shape) {
    case "boxed":
      return boxed;
    case "boxedDeep":
      return { list: [{ n: boxed }] };
    case "mapKey":
      return new Map([[boxed, 1]]);
    case "setMember":
      return { set: new Set([boxed]) };
    case "typed":
      return new BigInt64Array([7n]);
    case "cause":
      return new Error("x", { cause: 7n });
    case "hidden":
      return Object.defineProperty({}, "n", { value: 7n, enumerable: false });
    case "symbol":
      return { [Symbol("n")]: 7n };
    case "getter":
      return { get n() { return 7n; } };
    default:
      return shape;
  }
};

// What waitThenPoint waits for, until letGo: another call of the
// same code, in the same module.
let waiting: (() => void) | undefined;

export class App extends DurableObject {
  stub(binding: string): Stub {
    return (this.env as Record<string, Stub>)[binding] ?? {};
  }

  async everything(caller: Caller, as?: unknown): Promise<Record<string, unknown>> {
    const who = as ?? caller;
    return {
      list: await tried(() => this.stub("OUTLOOK").call(who, "mail.list", {})),
      send: await tried(() =>
        this.stub("MAIL").call(who, "mail.send", { to: "ben@acme.test", subject: "Hello" }, { idempotencyKey: crypto.randomUUID() })
      ),
      canWrite: await tried(() => this.stub("TASKS").canWrite(who)),
      save: await tried(() =>
        this.stub("TASKS").saveRecord(who, {
          path: "tasks/" + crypto.randomUUID() + ".md",
          ifVersion: 0,
          record: { type: "task", status: "open" },
          body: "Do it.",
        })
      ),
      point: await tried(() => this.stub("STATISTICS").record(who, { measure: "ticks", value: 1 })),
      write: await tried(() => this.stub("SELF").call(who, "change", {})),
    };
  }

  async lookUp(caller: Caller, input: { as?: Record<string, unknown> }): Promise<unknown> {
    // Dressed up from the caller it got: its token, and anything else.
    const as = input.as === undefined ? undefined : { ...caller, ...input.as };
    return await this.everything(caller, as);
  }

  async change(caller: Caller): Promise<unknown> {
    return await this.everything(caller);
  }

  async via(caller: Caller, method: string, input: unknown): Promise<unknown> {
    return await this.stub("DESK").call(caller, method, input);
  }

  async holdCaller(caller: Caller, wait: (held: Caller) => Promise<void>): Promise<string> {
    await wait(caller);
    return "let go";
  }

  async waitThenPoint(caller: Caller): Promise<unknown> {
    await this.ctx.storage.put("waiting", caller);
    await new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const point = await tried(() => this.stub("STATISTICS").record(caller, { measure: "ticks", value: 1 }));
    await this.ctx.storage.put("after", point);
    return point;
  }

  async isWaiting(): Promise<boolean> {
    return (await this.ctx.storage.get("waiting")) !== undefined;
  }

  async waitingCaller(): Promise<unknown> {
    return (await this.ctx.storage.get("waiting")) ?? null;
  }

  async letGo(): Promise<boolean> {
    await this.ctx.storage.delete("waiting");
    const resolve = waiting;
    waiting = undefined;
    resolve?.();
    return resolve !== undefined;
  }

  async pointAfter(caller: Caller, wait: (note: string) => Promise<void>): Promise<unknown> {
    await wait("held");
    const point = await tried(() => this.stub("STATISTICS").record(caller, { measure: "ticks", value: 1 }));
    await this.ctx.storage.put("after", point);
    return point;
  }

  async sendThenList(caller: Caller & { idempotencyKey?: string }): Promise<unknown> {
    const sent = await tried(() =>
      this.stub("MAIL").call(caller, "mail.send", { to: "ben@acme.test", subject: "Hello" }, { idempotencyKey: caller.idempotencyKey })
    );
    const listed = await tried(() => this.stub("OUTLOOK").call(caller, "mail.list", {}));
    await this.ctx.storage.put("after", { sent, listed });
    return { sent, listed };
  }

  async lastAfter(): Promise<unknown> {
    return (await this.ctx.storage.get("after")) ?? null;
  }

  echo(_caller: Caller, value: unknown): unknown {
    return value;
  }

  big(): bigint {
    return 7n;
  }

  carrying(_caller: Caller, shape: string): unknown {
    return carrying(shape);
  }

  async push(_caller: Caller, onChange: (value: unknown) => Promise<void>, value: unknown): Promise<unknown> {
    const pushed = value === "big" ? { deep: [7n] } : typeof value === "string" ? carrying(value) : value;
    return await tried(() => onChange(pushed));
  }

  fail(_caller: Caller, text: string, times: number): never {
    throw new Error(text.repeat(times));
  }
}
`;

/** What the App exports: `lookUp` reads, `change` writes. */
const exported = {
  lookUp: {
    access: "read",
    input: { type: "object" },
    output: {},
  },
  change: { access: "write", input: { type: "object" }, output: {} },
  sendThenList: { access: "write", input: { type: "object" }, output: {} },
  waitThenPoint: { access: "write", input: { type: "object" }, output: {} },
};

/** A `task` record type for `collection`. */
const taskType = (collection: string) =>
  JSON.stringify({
    task: {
      collection,
      description: "Something to do",
      schema: {
        type: "object",
        properties: { status: { enum: ["open", "done"] } },
        required: ["status"],
      },
    },
  });

/** A new App of `owner`'s running `server`, released and built. */
const newApp = async (
  owner: Person,
  files: Record<string, string> = {}
): Promise<AppId> => {
  const { id } = await owner.api.apps.create({ name: `Desk ${unique()}` });
  await serverBuilt(
    id,
    await release(owner, id, {
      "app/server.ts": server,
      "app/exports.json": JSON.stringify(exported),
      ...files,
    })
  );
  return appIdSchema.parse(id);
};

/**
 * The desk, granted something of every kind to read and change: Outlook
 * to read (it reaches connect), mail to send, a collection to write
 * records to, and its own exports (`SELF`, to call one marked `write`);
 * and the front desk, granted the desk's exports, whose screens call it.
 */
const setUp = async (
  plan: MailAnswer[] = [],
  frontFiles: Record<string, string> = {}
) => {
  const admin = await personApi("admin");
  const { id: collectionId } = await admin.api.knowledge.createCollection({
    name: `Tasks ${unique()}`,
    access: "everyone",
  });
  const desk = await newApp(admin, {
    "app/records.json": taskType(collectionId),
  });
  const front = await newApp(admin, frontFiles);
  const mail = await mailConnection(plan);
  const grant = async (
    subject: AppId,
    object:
      | { type: "connection"; connectionId: string }
      | { type: "collection"; collectionId: string }
      | { type: "app"; appId: string },
    actions: string[],
    binding: string
  ) =>
    await requestGranted(idp, admin, {
      subject: { type: "app", appId: subject },
      object,
      actions,
      binding,
    });
  const outlook = await grant(
    desk,
    { type: "connection", connectionId: "connection-outlook" },
    ["mail.list"],
    "OUTLOOK"
  );
  await grant(
    desk,
    { type: "connection", connectionId: mail.id },
    ["mail.send"],
    "MAIL"
  );
  await grant(
    desk,
    { type: "collection", collectionId },
    ["read", "write"],
    "TASKS"
  );
  const calls = await grant(
    front,
    { type: "app", appId: desk },
    ["read", "write"],
    "DESK"
  );
  // The desk's call of its own export marked `write`, from a read: only
  // the read stops it, never a missing grant.
  const other = await newApp(admin);
  await grant(desk, { type: "app", appId: other }, ["write"], "SELF");
  return {
    admin,
    desk,
    front,
    mail,
    calls,
    outlook: permissionIdSchema.parse(outlook),
  };
};

/**
 * A screen's callback that holds the App call it is called from until
 * `release`: `entered` once the App called it.
 */
const gate = () => {
  const entered = Promise.withResolvers<unknown>();
  const released = Promise.withResolvers<boolean>();
  return {
    entered: entered.promise,
    release: () => {
      released.resolve(true);
    },
    wait: async (value: unknown): Promise<void> => {
      entered.resolve(value);
      await released.promise;
    },
  };
};

/**
 * Waits until the App called `held`'s callback, and answers what it passed;
 * fails at once should `call` end first, rather than wait for a callback
 * that won't come.
 */
const entered = async (
  held: ReturnType<typeof gate>,
  call: Promise<string>
): Promise<unknown> =>
  await Promise.race([
    held.entered,
    call.then((ended) => {
      throw new Error(`The call ended before it was held: ${ended}`);
    }),
  ]);

/** A person using an App, as a call names them. */
const as = (userId: string) => ({ userId, mode: "interactive" }) as const;

/** A read of the documents table, as a save reads before it writes. */
const readsDocuments = /from "documents"/iu;

/** A read of permissions, as a stub call's permission check makes it. */
const readsPermissions = /from "permissions"/iu;

/** A read of guest chats, as a revoke finds its chat before it writes. */
const readsGuestChats = /from "guest_chats"/iu;

/**
 * The database `real`, with `first` run once, just before the statement
 * whose query `when` matches runs for the time after the first `skip`:
 * something changing while a stub call is on its way, after its first
 * checks and before it acts.
 */
const beforeRead = (
  real: D1Database,
  when: RegExp,
  first: () => Promise<void>,
  skip = 0
): D1Database => {
  let seen = 0;
  const once = async (): Promise<void> => {
    seen += 1;
    if (seen === skip + 1) {
      await first();
    }
  };
  const racing = (statement: D1PreparedStatement): D1PreparedStatement =>
    // SAFETY: an object whose prototype is `statement` is a statement: it
    // has every member, and the ones it runs by are replaced below.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    Object.assign(Object.create(statement) as D1PreparedStatement, {
      bind: (...values: unknown[]) => racing(statement.bind(...values)),
      first: async () => {
        await once();
        return await statement.first();
      },
      all: async () => {
        await once();
        return await statement.all();
      },
      raw: async () => {
        await once();
        return await statement.raw();
      },
      run: async () => {
        await once();
        return await statement.run();
      },
    });
  return {
    prepare: (query) => {
      const statement = real.prepare(query);
      return when.test(query) ? racing(statement) : statement;
    },
    batch: async <T>(statements: D1PreparedStatement[]) =>
      await real.batch<T>(statements),
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
};

/**
 * One of an App's stubs as core serves it to the App's code, run here on
 * `coreEnv`: core's own entrypoint, with its database raced.
 */
const stubOn = <Props, Stub>(
  Binding: new (ctx: ExecutionContext<Props>, env: Env) => Stub,
  props: Props,
  coreEnv: Env
): Stub => {
  const ctx: Pick<ExecutionContext<Props>, "props"> = { props };
  // SAFETY: the stubs read only `props` of their context.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return new Binding(ctx as ExecutionContext<Props>, coreEnv);
};

/** What the desk last did after its call was let go (`lastAfter`). */
const lastAfter = async (desk: AppId, userId: string): Promise<unknown> =>
  await callApp(env, desk, { userId, mode: "interactive" }, "lastAfter");

/** Calls `front`'s `via` for `userId`, as its screen would. */
const viaFront = async (
  front: AppId,
  userId: string,
  method: string,
  input: unknown
): Promise<unknown> =>
  await callApp(env, front, { userId, mode: "interactive" }, "via", [
    method,
    input,
  ]);

/** The error `promise` was refused with, as a screen gets it. */
const refusalOf = async (
  promise: Promise<unknown>
): Promise<{ code?: unknown; details?: unknown }> => {
  try {
    await promise;
  } catch (error) {
    return typeof error === "object" && error !== null ? error : {};
  }
  throw new Error("Expected a refusal");
};

/** How many bytes `details` take as UTF-8 JSON. */
const bytes = (details: unknown): number =>
  new TextEncoder().encode(JSON.stringify(details)).byteLength;

/** The message an error's details carry. */
const messageOf = (details: unknown): string =>
  typeof details === "object" &&
  details !== null &&
  "message" in details &&
  typeof details.message === "string"
    ? details.message
    : "";

describe("an App call's invocation", { timeout: 60_000 }, () => {
  it("lets a call through an export marked read change nothing, through any stub", async () => {
    const { admin, desk, front, mail } = await setUp();
    const read = await viaFront(front, admin.userId, "lookUp", {});
    const write = await viaFront(front, admin.userId, "change", {});
    expect({ read, write, mail: await mail.did() }).toStrictEqual({
      read: {
        list: reached,
        send: "connect.read_only",
        canWrite: false,
        save: "app.read_only",
        point: "app.read_only",
        write: "permission.denied",
      },
      write: {
        list: reached,
        // Held for the person, as a side effect from a screen is.
        send: "ok",
        canWrite: true,
        save: "ok",
        point: "ok",
        write: "ok",
      },
      // Nothing reached the mail server: the one send was held.
      mail: { calls: 0, sent: [] },
    });
    // The read held nothing for the person either: only the write's send.
    const held = await admin.api.pendingActions.list();
    expect(
      held.filter(
        ({ context }) => context.type === "app" && context.appId === desk
      )
    ).toHaveLength(1);
  });

  it("goes by the host's record of the call alone, however App code dresses its caller", async () => {
    const { admin, front } = await setUp();
    const dressedUp = await viaFront(front, admin.userId, "lookUp", {
      as: {
        kind: "write",
        readOnly: false,
        access: "write",
        mode: "workflow",
        userId: "someone-else",
        app: null,
      },
    });
    expect(dressedUp).toStrictEqual({
      list: reached,
      send: "connect.read_only",
      canWrite: false,
      save: "app.read_only",
      point: "app.read_only",
      write: "permission.denied",
    });
  });

  it("finds a big integer however a value carries it: boxed, in a map or set, typed, as a cause, or past a changed prototype", async () => {
    const admin = await personApi("admin");
    const app = await newApp(admin);
    const screen = { userId: admin.userId, mode: "interactive" } as const;
    const received: unknown[] = [];
    const onChange = (value: unknown): void => {
      received.push(value);
    };
    // The same shapes, built by the App (`carrying`) for its answers and
    // pushes, and here for a call's arguments.
    const boxed = new Object(7n);
    const carriers = {
      boxed,
      boxedDeep: { list: [{ n: boxed }] },
      mapKey: new Map([[boxed, 1]]),
      setMember: { set: new Set([boxed]) },
      typed: new BigInt64Array([7n]),
      cause: new Error("x", { cause: 7n }),
    };
    const refused: Record<string, unknown> = Object.fromEntries(
      await Promise.all(
        Object.entries(carriers).map(
          async ([shape, value]): Promise<[string, unknown]> => [
            shape,
            {
              sent: await outcome(callApp(env, app, screen, "echo", [value])),
              answered: await outcome(
                callApp(env, app, screen, "carrying", [shape])
              ),
              pushed: await admin.api.screens.call(app, "push", [
                onChange,
                shape,
              ]),
            },
          ]
        )
      )
    );
    const everywhere = {
      sent: "app.call_invalid",
      answered: "app.answer_invalid",
      pushed: "app.answer_invalid",
    };
    expect({
      refused,
      // A boxed big integer whose prototype is gone is one all the same.
      bare: await outcome(
        callApp(env, app, screen, "echo", [
          Object.setPrototypeOf(new Object(7n), null),
        ])
      ),
      received,
    }).toStrictEqual({
      refused: Object.fromEntries(
        Object.keys(carriers).map((shape) => [shape, everywhere])
      ),
      bare: "app.call_invalid",
      received: [],
    });
  });

  it("goes by what a call carries: a getter as read once, no hidden or symbol key", async () => {
    const admin = await personApi("admin");
    const app = await newApp(admin);
    const screen = { userId: admin.userId, mode: "interactive" } as const;
    const received: unknown[] = [];
    const onChange = (value: unknown): void => {
      received.push(value);
    };
    // A getter that answers a number when first read and a big integer
    // after: what reaches the App is what it was read as, once.
    let reads = 0;
    const flaky = {
      get n(): unknown {
        reads += 1;
        return reads === 1 ? 1 : 7n;
      },
    };
    expect({
      flaky: await callApp(env, app, screen, "echo", [flaky]),
      hidden: await callApp(env, app, screen, "echo", [
        Object.defineProperty({}, "n", { value: 7n, enumerable: false }),
      ]),
      symbol: await callApp(env, app, screen, "echo", [{ [Symbol("n")]: 7n }]),
      // The App's getter is read as its answer leaves it: a big integer.
      getter: await outcome(callApp(env, app, screen, "carrying", ["getter"])),
      pushedGetter: await admin.api.screens.call(app, "push", [
        onChange,
        "getter",
      ]),
      pushedHidden: await admin.api.screens.call(app, "push", [
        onChange,
        "hidden",
      ]),
      pushedSymbol: await admin.api.screens.call(app, "push", [
        onChange,
        "symbol",
      ]),
      received,
    }).toStrictEqual({
      flaky: { n: 1 },
      hidden: {},
      symbol: {},
      getter: "app.answer_invalid",
      pushedGetter: "app.answer_invalid",
      pushedHidden: "ok",
      pushedSymbol: "ok",
      // Neither hidden nor symbol key went with its push.
      received: [{}, {}],
    });
  });

  it("takes no big integer into a call, out of one, or pushed to a screen", async () => {
    const admin = await personApi("admin");
    const app = await newApp(admin);
    const screen = { userId: admin.userId, mode: "interactive" } as const;
    const run = {
      userId: admin.userId,
      mode: "workflow",
      idempotencyKey: `${crypto.randomUUID()}:step`,
    } as const;
    // What the App pushes a screen through its callback: no big integer
    // either.
    const received: unknown[] = [];
    const onChange = (value: unknown): void => {
      received.push(value);
    };
    expect({
      sent: await outcome(callApp(env, app, screen, "echo", [7n])),
      sentDeep: await outcome(
        callApp(env, app, run, "echo", [{ list: [new Map([["n", 7n]])] }])
      ),
      answered: await outcome(callApp(env, app, screen, "big")),
      plain: await callApp(env, app, screen, "echo", [{ n: 7 }]),
      fromScreen: await outcome(admin.api.screens.call(app, "echo", [7n])),
      pushedBig: await admin.api.screens.call(app, "push", [onChange, "big"]),
      pushedPlain: await admin.api.screens.call(app, "push", [onChange, 7]),
      received,
    }).toStrictEqual({
      sent: "app.call_invalid",
      sentDeep: "app.call_invalid",
      answered: "app.answer_invalid",
      plain: { n: 7 },
      fromScreen: "app.call_invalid",
      pushedBig: "app.answer_invalid",
      pushedPlain: "ok",
      // Only the plain value reached the screen.
      received: [7],
    });
  });

  it("carries no more of an App's error message to a screen than an error may, cut at a whole character", async () => {
    const admin = await personApi("admin");
    const app = await newApp(admin);
    const fail = async (text: string, times: number) =>
      await refusalOf(admin.api.screens.call(app, "fail", [text, times]));

    const short = await fail("Invoice 7 has no total. ", 2);
    const long = await fail("Invoice 7 has no total. ", 10_000);
    // Each four bytes in UTF-8, two UTF-16 code units, and never split.
    const wide = await fail("😀", 10_000);
    expect({
      codes: [short.code, long.code, wide.code],
      short: short.details,
      long: {
        fits: bytes(long.details) <= appErrorDetailsBytes,
        nearlyAll: bytes(long.details) > appErrorDetailsBytes - 64,
        start: messageOf(long.details).startsWith("Invoice 7 has no total. "),
      },
      wide: {
        fits: bytes(wide.details) <= appErrorDetailsBytes,
        whole: /^(?:😀)+$/u.test(messageOf(wide.details)),
      },
    }).toStrictEqual({
      codes: ["app.failed", "app.failed", "app.failed"],
      short: {
        version: 1,
        method: "fail",
        message: "Invoice 7 has no total. Invoice 7 has no total. ",
      },
      long: { fits: true, nearlyAll: true, start: true },
      wide: { fits: true, whole: true },
    });
  });

  it("stops acting for someone who loses their role in the App while their screen's call runs", async () => {
    const admin = await personApi("admin");
    // Granted nothing, so it may be shared with anyone.
    const desk = await newApp(admin);
    const clerk = await personApi("user");
    const team = await newTeam(admin, [clerk]);
    await admin.api.apps.members.add(desk, {
      type: "team",
      id: team,
      role: "user",
    });
    const pointAfter = async (meanwhile: () => Promise<unknown>) => {
      const held = gate();
      const call = outcome(
        clerk.api.screens.call(desk, "pointAfter", [held.wait])
      );
      await entered(held, call);
      await meanwhile();
      held.release();
      await call;
      return await lastAfter(desk, admin.userId);
    };

    const stays = await pointAfter(async () => {
      // Nothing changes for them.
    });
    // Leaving the team the App is shared with restarts nothing: the call
    // goes on, and only the check of each stub call stops it.
    const leaves = await pointAfter(
      async () =>
        await callAuth("/organization/remove-team-member", admin.session, {
          teamId: team,
          userId: clerk.userId,
        })
    );
    expect({ stays, leaves }).toStrictEqual({
      stays: "ok",
      leaves: "app.not_found",
    });
  });

  it("stops acting for another App whose permission on its export is revoked while the call runs", async () => {
    const relay = workflowFiles(
      "relay",
      `  return await step.do("ask", { description: "Ask the desk" }, async () =>
    await appExports<{ sendThenList: (input: object) => unknown }>(env.DESK).sendThenList({})
  );`,
      { ask: { sent: "ok", listed: "ok" } }
    );
    const { admin, desk, front, mail, calls } = await setUp(
      ["slow"],
      Object.fromEntries(
        Object.entries(relay).map(([path, text]) => [
          path,
          text.replace(
            "import { workflow, z }",
            "import { appExports, workflow, z }"
          ),
        ])
      )
    );
    const { id: run } = await admin.api.workflows.start(front, "relay");
    // The desk's send is out, held at the mail server.
    try {
      await vi.waitFor(
        async () => {
          await expect(mail.holding()).resolves.toBeTruthy();
        },
        { timeout: 15_000, interval: 100 }
      );
      await admin.api.permissions.revoke(calls);
    } finally {
      await mail.release();
    }
    await finished(run);
    expect({
      after: await lastAfter(desk, admin.userId),
      mail: await mail.did(),
    }).toStrictEqual({
      // The send went out before the revoke; nothing after it did.
      after: { sent: "ok", listed: "permission.denied" },
      mail: { calls: 1, sent: [{ to: "ben@acme.test", subject: "Hello" }] },
    });
  });

  it("does nothing more once its App's code is restarted while the call runs", async () => {
    const admin = await personApi("admin");
    const desk = await newApp(admin);
    const held = gate();
    const call = outcome(
      admin.api.screens.call(desk, "pointAfter", [held.wait])
    );
    await entered(held, call);
    // A permission granted restarts the App's code, in a new isolate with
    // the permissions as they are now.
    await requestGranted(idp, admin, {
      subject: { type: "app", appId: desk },
      object: { type: "connection", connectionId: "connection-outlook" },
      actions: ["mail.list"],
      binding: "OUTLOOK",
    });
    held.release();
    // However the screen hears of it, the call failed, and its code did
    // nothing once let go: not even a refused statistics point.
    await expect(call).resolves.not.toBe("ok");
    await expect(lastAfter(desk, admin.userId)).resolves.toBeNull();
  });

  it("stops a call down a chain of Apps once the person loses their role in the App the chain started in", async () => {
    const admin = await personApi("admin");
    // Granted nothing but the desk's exports, so the front desk may be
    // shared with anyone.
    const [desk, front] = await Promise.all([newApp(admin), newApp(admin)]);
    await requestGranted(idp, admin, {
      subject: { type: "app", appId: front },
      object: { type: "app", appId: desk },
      actions: ["write"],
      binding: "DESK",
    });
    // Its data stays fine for its screens' unapproved code, as a release
    // leaves it.
    await ordinaryData(front);
    const clerk = await personApi("user");
    const team = await newTeam(admin, [clerk]);
    await admin.api.apps.members.add(front, {
      type: "team",
      id: team,
      role: "user",
    });
    // The clerk's screen of the front desk calls the desk's export, which
    // waits in the desk until let go.
    const pointAfter = async (meanwhile: () => Promise<unknown>) => {
      const call = outcome(
        clerk.api.screens.call(front, "via", ["waitThenPoint", {}])
      );
      await vi.waitFor(
        async () => {
          await expect(
            callApp(env, desk, as(admin.userId), "isWaiting")
          ).resolves.toBeTruthy();
        },
        { timeout: 15_000, interval: 50 }
      );
      await meanwhile();
      await expect(
        callApp(env, desk, as(admin.userId), "letGo")
      ).resolves.toBeTruthy();
      await call;
      return await lastAfter(desk, admin.userId);
    };

    const stays = await pointAfter(async () => {
      // Nothing changes for them.
    });
    // The desk's own grant, the front desk's permission on its export,
    // still holds: only the front desk's call, admitted again with the
    // desk's, stops it.
    const leaves = await pointAfter(
      async () =>
        await callAuth("/organization/remove-team-member", admin.session, {
          teamId: team,
          userId: clerk.userId,
        })
    );
    expect({ stays, leaves }).toStrictEqual({
      stays: "ok",
      leaves: "app.not_found",
    });
  });

  it("writes no record once what let its call in is gone, however late in the save that happens", async () => {
    const admin = await personApi("admin");
    const clerk = await personApi("user");
    const team = await newTeam(admin, [clerk]);
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Tasks ${unique()}`,
      access: "teams",
      teams: [team],
    });
    const desk = await newApp(admin, {
      "app/records.json": taskType(collectionId),
    });
    await admin.api.apps.members.add(desk, {
      type: "team",
      id: team,
      role: "user",
    });
    const permissionId = permissionIdSchema.parse(
      await requestGranted(idp, admin, {
        subject: { type: "app", appId: desk },
        object: { type: "collection", collectionId },
        actions: ["read", "write"],
        binding: "TASKS",
      })
    );
    await ordinaryData(desk);
    // A screen call of the clerk's, held, whose caller the screen gets:
    // the save below is the desk's record stub's, for that call.
    const held = gate();
    const call = outcome(
      clerk.api.screens.call(desk, "holdCaller", [held.wait])
    );
    const caller = await entered(held, call);
    const save = async (path: string, leave: boolean): Promise<string> => {
      // The clerk leaves the team once the save has checked everything it
      // checks first, and before its write.
      const racing = beforeRead(env.KNOWLEDGE, readsDocuments, async () => {
        if (leave) {
          await callAuth("/organization/remove-team-member", admin.session, {
            teamId: team,
            userId: clerk.userId,
          });
        }
      });
      return await outcome(
        stubOn(
          AppCollectionBinding,
          {
            app: desk,
            context: { type: "app", appId: desk },
            permissionId,
            collectionId: collectionIdSchema.parse(collectionId),
          },
          { ...env, KNOWLEDGE: racing }
        ).saveRecord(caller, {
          path,
          ifVersion: 0,
          record: { type: "task", status: "open" },
          body: "",
        })
      );
    };
    const stays = `tasks/${unique()}.md`;
    const leaves = `tasks/${unique()}.md`;
    const results = {
      stays: await save(stays, false),
      leaves: await save(leaves, true),
    };
    held.release();
    await call;
    const written = await env.KNOWLEDGE.prepare(
      "SELECT path FROM documents WHERE collection_id = ? ORDER BY path"
    )
      .bind(collectionId)
      .all<{ path: string }>();
    expect({
      results,
      written: written.results.map(({ path }) => path),
    }).toStrictEqual({
      results: { stays: "ok", leaves: "app.not_found" },
      written: [stays],
    });
  });

  it("reaches no connection, invites no guest and revokes no chat once the person loses their role in the App, however late in the stub call that happens", async () => {
    const admin = await personApi("admin");
    const desk = await newApp(admin);
    const granted = async (
      object:
        | { type: "connection"; connectionId: string }
        | { type: "platform" },
      actions: string[],
      binding: string
    ) =>
      permissionIdSchema.parse(
        await requestGranted(idp, admin, {
          subject: { type: "app", appId: desk },
          object,
          actions,
          binding,
        })
      );
    // A shared connection, so the desk may be shared with anyone.
    const mail = await mailConnection([], mailWithSearch);
    const search = await granted(
      { type: "connection", connectionId: mail.id },
      ["mail.search"],
      "MAIL"
    );
    const guests = await granted({ type: "platform" }, ["guests"], "GUESTS");
    await ordinaryData(desk);
    // A clerk for each stub call, each in a team of their own the desk is
    // shared with, each with a screen call of the desk held: the stub
    // calls below are the desk's stubs', for those calls.
    const clerks = await Promise.all(
      ["search", "invite", "revoke"].map(async () => {
        const clerk = await personApi("user");
        const team = await newTeam(admin, [clerk]);
        await admin.api.apps.members.add(desk, {
          type: "team",
          id: team,
          role: "user",
        });
        const held = gate();
        const call = outcome(
          clerk.api.screens.call(desk, "holdCaller", [held.wait])
        );
        return {
          caller: await entered(held, call),
          leave: async () => {
            await callAuth("/organization/remove-team-member", admin.session, {
              teamId: team,
              userId: clerk.userId,
            });
          },
          done: async () => {
            held.release();
            await call;
          },
        };
      })
    );
    const [lister, inviter, revoker] = clerks;
    if (
      lister === undefined ||
      inviter === undefined ||
      revoker === undefined
    ) {
      throw new Error("Expected three clerks");
    }
    const connection = (coreEnv: Env) =>
      stubOn(
        AppConnectionBinding,
        {
          app: desk,
          context: { type: "app", appId: desk },
          permissionId: search,
          connection: { type: "connection", connectionId: mail.id },
        },
        coreEnv
      );
    const guestChats = (coreEnv: Env) =>
      stubOn(AppGuestsBinding, { app: desk, permissionId: guests }, coreEnv);
    // Core's database, with the clerk leaving their team just before the
    // first read `when` matches: after the stub call was admitted, before
    // it acts.
    const leaving = (clerk: { leave: () => Promise<void> }, when: RegExp) => ({
      ...env,
      DB: beforeRead(env.DB, when, clerk.leave),
    });
    const anna = { name: "Anna", skill: "interview-a-stakeholder" };

    const stays = {
      search: await outcome(
        connection(env).call(lister.caller, "mail.search", { query: "stays" })
      ),
      invite: await outcome(guestChats(env).invite(inviter.caller, anna)),
    };
    const chat = await guestChats(env).invite(revoker.caller, anna);
    const leaves = {
      search: await outcome(
        connection(leaving(lister, readsPermissions)).call(
          lister.caller,
          "mail.search",
          { query: "leaves" }
        )
      ),
      invite: await outcome(
        guestChats(leaving(inviter, readsPermissions)).invite(
          inviter.caller,
          anna
        )
      ),
      revoke: await outcome(
        guestChats(leaving(revoker, readsGuestChats)).revoke(
          revoker.caller,
          chat.id
        )
      ),
    };
    await Promise.all(
      clerks.map(async ({ done }) => {
        await done();
      })
    );
    const chats = await env.DB.prepare(
      "SELECT ended FROM guest_chats WHERE app_id = ? ORDER BY created_at"
    )
      .bind(desk)
      .all<{ ended: string | null }>();
    expect({
      stays,
      leaves,
      // Only the two invitations made before anyone left; neither revoked.
      chats: chats.results.map(({ ended }) => ended),
      // Only the search made before anyone left reached the mail server.
      searched: await mail.searched(),
    }).toStrictEqual({
      stays: { search: "ok", invite: "ok" },
      leaves: {
        search: "app.not_found",
        invite: "app.not_found",
        revoke: "app.not_found",
      },
      chats: [null, null],
      searched: ["stays"],
    });
  });

  it("reaches no connection once the App a call came through loses its permission, however late in the stub call that happens", async () => {
    const { admin, desk, front, calls, outlook } = await setUp();
    // The front desk's call of the desk's export, waiting in the desk.
    const call = outcome(viaFront(front, admin.userId, "waitThenPoint", {}));
    await vi.waitFor(
      async () => {
        await expect(
          callApp(env, desk, as(admin.userId), "isWaiting")
        ).resolves.toBeTruthy();
      },
      { timeout: 15_000, interval: 50 }
    );
    const caller = await callApp(env, desk, as(admin.userId), "waitingCaller");
    const list = async (coreEnv: Env): Promise<string> =>
      await outcome(
        stubOn(
          AppConnectionBinding,
          {
            app: desk,
            context: { type: "app", appId: desk },
            permissionId: outlook,
            connection: {
              type: "connection",
              connectionId: "connection-outlook",
            },
          },
          coreEnv
        ).call(caller, "mail.list", {})
      );
    const stays = await list(env);
    // Revoked once the stub call was admitted, as its own permission is
    // checked: the second read of permissions, after the front desk's.
    const revoked = await list({
      ...env,
      DB: beforeRead(
        env.DB,
        readsPermissions,
        async () => {
          await admin.api.permissions.revoke(calls);
        },
        1
      ),
    });
    await callApp(env, desk, as(admin.userId), "letGo");
    await call;
    expect({ stays, revoked }).toStrictEqual({
      stays: reached,
      revoked: "permission.denied",
    });
  });
});
