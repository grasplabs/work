import { appErrorDetailsBytes } from "@grasp-os/shared/apps";
import {
  appIdSchema,
  collectionIdSchema,
  permissionIdSchema,
} from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { AppConnectionBinding } from "../src/app-bindings.ts";
import { callApp, waitingCallsLimit } from "../src/app.ts";
import type { ExportCall } from "../src/app.ts";
import { appHost } from "../src/durable-objects.ts";
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
//   invited or a guest chat be revoked;
// - App code keeps a caller's token in module state and uses it from
//   another call running at the same time, acting as the first caller:
//   so calls run one at a time, and a call has a token only while it
//   holds the App;
// - that one-at-a-time hold leaks: a call that fails, or is given up on
//   while its code goes on, never lets go, and the App takes no call
//   again;
// - a call waits for its turn past its deadline, or is let in once its
//   caller gave up, or calls pile up without end behind a slow one;
// - waiting calls are let in out of order, so one can wait for ever.
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

// Module state every call of this code shares: the caller keepAndHold
// kept, and a count of calls (tick).
let kept: Caller | undefined;
let ticks = 0;

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

  // Waits at the mail server, which holds the search until the test lets
  // it go: the App takes no other call meanwhile. The query carries the
  // caller, for the test to act with while the call runs.
  async searchThenPoint(caller: Caller): Promise<unknown> {
    await tried(() => this.stub("MAIL").call(caller, "mail.search", { query: "hold " + JSON.stringify(caller) }));
    const point = await tried(() => this.stub("STATISTICS").record(caller, { measure: "ticks", value: 1 }));
    await this.ctx.storage.put("after", point);
    return point;
  }

  async keepAndHold(caller: Caller, wait: (held: Caller) => Promise<void>): Promise<number> {
    kept = caller;
    await wait(caller);
    return this.tick();
  }

  tick(): number {
    ticks += 1;
    return ticks;
  }

  // Lists mail as the caller keepAndHold kept, noting that it ran.
  async listAsKept(caller: Caller, note: string): Promise<unknown> {
    const ran = ((await this.ctx.storage.get("ran")) as string[] | undefined) ?? [];
    await this.ctx.storage.put("ran", [...ran, note]);
    return await tried(() => this.stub("OUTLOOK").call(kept ?? caller, "mail.list", {}));
  }

  async ran(): Promise<unknown> {
    return (await this.ctx.storage.get("ran")) ?? [];
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
  searchThenPoint: { access: "write", input: { type: "object" }, output: {} },
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
 * What lets go of each hold a test made (a gate, a mail search held):
 * `afterEach` lets go of them all, however the test ended, so a test that
 * fails holding a call fails alone, instead of keeping an App's code, or
 * the run, waiting.
 */
const holds = new Set<() => Promise<void> | void>();

/**
 * A mail connection with `mail.search`, whose server answers as `plan`
 * says: a search it holds is let go after the test (`holds`).
 */
const heldMail = async (plan: MailAnswer[]) => {
  const mail = await mailConnection(plan, mailWithSearch);
  holds.add(mail.release);
  return mail;
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
  const mail = await heldMail(plan);
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
    ["mail.send", "mail.search"],
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
  holds.add(() => {
    released.resolve(true);
  });
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
 * How long a test waits for a step it is sure of (a call reaching its
 * hold, answering once let go, the App's object taking a call), before it
 * fails: well within the test's own time, so a test that goes wrong fails
 * fast, with what it waited for. A real wait, not the faked clock's.
 */
const stepMs = 5000;

/** Answers what `step` settles to, or fails once `stepMs` passes first. */
const bounded = async <T>(step: Promise<T>, what: string): Promise<T> =>
  await Promise.race([
    step,
    scheduler.wait(stepMs).then(() => {
      throw new Error(`Gave up after ${stepMs} ms waiting for ${what}`);
    }),
  ]);

/**
 * Waits until the App called `held`'s callback, and answers what it passed;
 * fails at once should `call` end first, rather than wait for a callback
 * that won't come, and fails within `stepMs` should neither happen.
 */
const entered = async (
  held: ReturnType<typeof gate>,
  call: Promise<unknown>
): Promise<unknown> =>
  await bounded(
    Promise.race([
      held.entered,
      call.then((ended) => {
        throw new Error(`The call ended before it was held: ${String(ended)}`);
      }),
    ]),
    "the App to call the held callback"
  );

/**
 * Fakes the clock and the timers of this isolate, the App's object's
 * included, and notes the delay of each timer set on it from then on:
 * how a test knows a call reached the App and set its deadline (`armed`).
 */
const fakeClock = (): { delays: number[]; seen: number } => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const delays: number[] = [];
  const clock = { delays, seen: 0 };
  const fake = globalThis.setTimeout;
  // Put back as it was by `vi.useRealTimers`, which restores the real one.
  Reflect.set(globalThis, "setTimeout", (callback: () => void, ms?: number) => {
    clock.delays.push(ms ?? 0);
    return fake(callback, ms);
  });
  return clock;
};

/** How often `armed` looks again. */
const armedPollMs = 5;

/**
 * Waits until a timer of `ms` was set on the faked clock (`fakeClock`)
 * since the one `armed` last found: until a call made to the App arrived
 * and set its deadline. A call made through the stub can arrive after a
 * later `runInDurableObject` (`advance`), which reaches the object by
 * another route, and under load often does: moved on before it arrived,
 * the clock would start the call's deadline later than the test means,
 * or, for a call through an export whose deadline its caller set, pass it
 * before the call even waits.
 */
const armed = async (
  clock: { delays: number[]; seen: number },
  ms: number
): Promise<void> => {
  for (let waited = 0; waited < stepMs; waited += armedPollMs) {
    const at = clock.delays.indexOf(ms, clock.seen);
    if (at !== -1) {
      clock.seen = at + 1;
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- a real pause between looks
    await scheduler.wait(armedPollMs);
  }
  throw new Error(
    `Gave up after ${stepMs} ms waiting for a call to set its ${ms} ms deadline`
  );
};

/**
 * Moves the faked clock on by `ms` in the App's object (`host`), whose
 * deadlines' timers they are.
 */
const advance = async (
  host: ReturnType<typeof appHost>,
  ms: number
): Promise<void> => {
  await runInDurableObject(host, async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** Waits until `mail`'s server holds a search the App made. */
const heldAtSearch = async (mail: { holding: () => Promise<boolean> }) => {
  await vi.waitFor(
    async () => {
      await expect(mail.holding()).resolves.toBeTruthy();
    },
    { timeout: 15_000, interval: 50 }
  );
};

/**
 * What a call through an export carries besides its caller (app-calls.ts),
 * for the App's first version, from a call with `ms` left.
 */
const exportCall = (ms: number): ExportCall => ({
  version: 1,
  chain: [],
  deadline: Date.now() + ms,
  readOnly: false,
  onPinned: async () => {},
});

/** Outlook, granted to `app` as `OUTLOOK`. */
const grantOutlook = async (admin: Person, app: AppId) =>
  await requestGranted(idp, admin, {
    subject: { type: "app", appId: app },
    object: { type: "connection", connectionId: "connection-outlook" },
    actions: ["mail.list"],
    binding: "OUTLOOK",
  });

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
  // Lets go of every hold the test made (`holds`), and of the faked clock.
  afterEach(async () => {
    vi.useRealTimers();
    const releases = [...holds];
    holds.clear();
    await Promise.allSettled(
      releases.map(async (letGo) => {
        await letGo();
      })
    );
  });

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
    // A shared connection, so the desk reads nothing the front desk's
    // people couldn't: its search is where the desk's call waits.
    const mail = await heldMail([]);
    await requestGranted(idp, admin, {
      subject: { type: "app", appId: desk },
      object: { type: "connection", connectionId: mail.id },
      actions: ["mail.search"],
      binding: "MAIL",
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
    // waits at the mail server until let go.
    const pointAfter = async (meanwhile: () => Promise<unknown>) => {
      const call = outcome(
        clerk.api.screens.call(front, "via", ["searchThenPoint", {}])
      );
      try {
        await heldAtSearch(mail);
        await meanwhile();
      } finally {
        await mail.release();
      }
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
    const mail = await heldMail([]);
    const search = await granted(
      { type: "connection", connectionId: mail.id },
      ["mail.search"],
      "MAIL"
    );
    const guests = await granted({ type: "platform" }, ["guests"], "GUESTS");
    await ordinaryData(desk);
    // A clerk for each stub call, each in a team of their own the desk is
    // shared with: the stub calls below are the desk's stubs', for a
    // screen call of the clerk's held in the desk meanwhile, one clerk at
    // a time, as the desk takes calls.
    const clerks = await Promise.all(
      ["search", "invite", "revoke"].map(async () => {
        const clerk = await personApi("user");
        const team = await newTeam(admin, [clerk]);
        await admin.api.apps.members.add(desk, {
          type: "team",
          id: team,
          role: "user",
        });
        return {
          leave: async () => {
            await callAuth("/organization/remove-team-member", admin.session, {
              teamId: team,
              userId: clerk.userId,
            });
          },
          whileHeld: async <T>(
            act: (caller: unknown) => Promise<T>
          ): Promise<T> => {
            const held = gate();
            const call = outcome(
              clerk.api.screens.call(desk, "holdCaller", [held.wait])
            );
            try {
              return await act(await entered(held, call));
            } finally {
              held.release();
              await call;
            }
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

    const searches = await lister.whileHeld(async (caller) => ({
      stays: await outcome(
        connection(env).call(caller, "mail.search", { query: "stays" })
      ),
      leaves: await outcome(
        connection(leaving(lister, readsPermissions)).call(
          caller,
          "mail.search",
          { query: "leaves" }
        )
      ),
    }));
    const invites = await inviter.whileHeld(async (caller) => ({
      stays: await outcome(guestChats(env).invite(caller, anna)),
      leaves: await outcome(
        guestChats(leaving(inviter, readsPermissions)).invite(caller, anna)
      ),
    }));
    const revoke = await revoker.whileHeld(async (caller) => {
      const chat = await guestChats(env).invite(caller, anna);
      return await outcome(
        guestChats(leaving(revoker, readsGuestChats)).revoke(caller, chat.id)
      );
    });
    const chats = await env.DB.prepare(
      "SELECT ended FROM guest_chats WHERE app_id = ? ORDER BY created_at"
    )
      .bind(desk)
      .all<{ ended: string | null }>();
    expect({
      stays: { search: searches.stays, invite: invites.stays },
      leaves: { search: searches.leaves, invite: invites.leaves, revoke },
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
    const { admin, desk, front, mail, calls, outlook } = await setUp();
    // The front desk's call of the desk's export, waiting in the desk at
    // the mail server, whose query carries its caller.
    const call = outcome(viaFront(front, admin.userId, "searchThenPoint", {}));
    await heldAtSearch(mail);
    const [query = ""] = await mail.searched();
    const caller: unknown = JSON.parse(query.slice("hold ".length));
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
    await mail.release();
    await call;
    expect({ stays, revoked }).toStrictEqual({
      stays: reached,
      revoked: "permission.denied",
    });
  });

  it("runs one call at a time: a call that comes meanwhile waits, can't act as the running call's caller, and gives up with app.busy, never run", async () => {
    const admin = await personApi("admin");
    const desk = await newApp(admin);
    await grantOutlook(admin, desk);
    // One stub, so the calls reach the App in the order they are made.
    const host = appHost(env, desk);
    const caller = as(admin.userId);
    const held = gate();
    const holding = outcome(host.call(caller, "keepAndHold", [held.wait]));
    await entered(held, holding);
    // Comes while the first call holds the App, which kept its caller,
    // through an export from a call with half a second left.
    const meanwhile = await outcome(
      host.call(caller, "listAsKept", ["meanwhile"], exportCall(500))
    );
    held.release();
    expect({
      meanwhile,
      holding: await holding,
      // The kept caller's call has ended: its token acts no more.
      after: await callApp(env, desk, caller, "listAsKept", ["after"]),
      ran: await callApp(env, desk, caller, "ran"),
    }).toStrictEqual({
      meanwhile: "app.busy",
      holding: "ok",
      after: "app.caller_invalid",
      ran: ["after"],
    });
  });

  it("lets waiting calls in one at a time, in the order they came, once the call holding the App lets go", async () => {
    const admin = await personApi("admin");
    const desk = await newApp(admin);
    const host = appHost(env, desk);
    const caller = as(admin.userId);
    const held = gate();
    const first = host.call(caller, "keepAndHold", [held.wait]);
    await entered(held, first);
    const tick = async (): Promise<unknown> =>
      await host.call(caller, "tick", []);
    const waiting = [tick(), tick(), tick()];
    // Behind them, one whose deadline passes while it waits: never let
    // in after, so the App goes on taking calls.
    const gaveUp = await outcome(
      host.call(caller, "tick", [], exportCall(500))
    );
    held.release();
    expect({
      gaveUp,
      first: await first,
      waiting: await Promise.all(waiting),
      next: await callApp(env, desk, caller, "tick"),
    }).toStrictEqual({
      gaveUp: "app.busy",
      first: 1,
      waiting: [2, 3, 4],
      next: 5,
    });
  });

  it("lets the next call in however a call ends: answered or failed", async () => {
    const admin = await personApi("admin");
    const desk = await newApp(admin);
    const host = appHost(env, desk);
    const caller = as(admin.userId);
    expect({
      failed: await outcome(host.call(caller, "fail", ["No total.", 1])),
      afterFailed: await host.call(caller, "tick", []),
      afterAnswered: await host.call(caller, "tick", []),
    }).toStrictEqual({
      failed: "app.failed",
      afterFailed: 1,
      afterAnswered: 2,
    });
  });

  it("keeps a call cut short in the App until its code settles, and gives a call that waited its turn the App's own time from then", async () => {
    const admin = await personApi("admin");
    const desk = await newApp(admin);
    const host = appHost(env, desk);
    const caller = as(admin.userId);
    // Started ahead, so the first call's code runs at once.
    await host.call(caller, "ran", []);
    const first = gate();
    const second = gate();
    // The deadlines' timers, and the clock, are held, and moved on in the
    // App's object (`advance`).
    const clock = fakeClock();
    let waited: string;
    let meanwhile: string;
    try {
      const holding = host.call(caller, "keepAndHold", [first.wait]);
      await entered(first, holding);
      await armed(clock, 10_000);
      // Waits six of its ten seconds for its turn, then has four left of
      // its deadline: its caller hears it timed out, but its code had
      // nowhere near the App's own time, so it isn't stopped.
      const waiting = outcome(host.call(caller, "keepAndHold", [second.wait]));
      await armed(clock, 10_000);
      await advance(host, 6000);
      first.release();
      await bounded<unknown>(holding, "the first call to answer once let go");
      await entered(second, waiting);
      await advance(host, 4001);
      waited = await bounded(waiting, "the waiting call's deadline");
      // Its code still runs: the App takes no other call until it settles.
      const queued = outcome(host.call(caller, "tick", [], exportCall(500)));
      await armed(clock, 500);
      await advance(host, 500);
      meanwhile = await bounded(queued, "the queued call to give up");
    } finally {
      vi.useRealTimers();
      first.release();
      second.release();
    }
    expect({
      waited,
      meanwhile,
      // The cut-off code ticked once it was let go, before this call, in
      // code that wasn't restarted.
      next: await host.call(caller, "tick", []),
    }).toStrictEqual({
      waited: "app.timed_out",
      meanwhile: "app.busy",
      next: 3,
    });
  });

  it("stops a call from another App cut short whose code never settles at the App's own time from its turn, then lets the next in", async () => {
    const admin = await personApi("admin");
    const desk = await newApp(admin);
    const host = appHost(env, desk);
    const caller = as(admin.userId);
    const countBefore = await host.call(caller, "tick", []);
    const held = gate();
    const clock = fakeClock();
    let cutShort: string;
    let meanwhile: string;
    try {
      // Through an export from a call with five seconds left: another App
      // can't stop this one's code by calling it late, so its code has
      // the App's own time.
      const call = outcome(
        host.call(caller, "keepAndHold", [held.wait], exportCall(5000))
      );
      await entered(held, call);
      await advance(host, 5000);
      cutShort = await bounded(call, "the call's deadline");
      const queued = outcome(host.call(caller, "tick", [], exportCall(500)));
      await armed(clock, 500);
      await advance(host, 500);
      meanwhile = await bounded(queued, "the queued call to give up");
      // Its code never settles: at the App's own time, it is stopped.
      await advance(host, 10_000);
    } finally {
      vi.useRealTimers();
    }
    try {
      expect({
        countBefore,
        cutShort,
        meanwhile,
        // In code started afresh: the count starts again.
        next: await host.call(caller, "tick", []),
      }).toStrictEqual({
        countBefore: 1,
        cutShort: "app.timed_out",
        meanwhile: "app.busy",
        next: 1,
      });
    } finally {
      held.release();
    }
  });

  it("stops a call cut short by its own caller's deadline, whose code never settles, that long from its turn", async () => {
    const admin = await personApi("admin");
    const desk = await newApp(admin);
    const host = appHost(env, desk);
    const caller = as(admin.userId);
    const countBefore = await host.call(caller, "tick", []);
    const held = gate();
    fakeClock();
    let cutShort: string;
    try {
      // A caller that waits five seconds, as a workflow step's attempt
      // does: its code gets five seconds from its turn, then is stopped.
      const call = outcome(
        host.call(
          caller,
          "keepAndHold",
          [held.wait],
          undefined,
          Date.now() + 5000
        )
      );
      await entered(held, call);
      await advance(host, 5000);
      cutShort = await bounded(call, "the call's deadline");
      // Its code never settles: it is stopped as its time from its turn
      // is up, which it is.
      await advance(host, 1);
    } finally {
      vi.useRealTimers();
    }
    try {
      expect({
        countBefore,
        cutShort,
        // In code started afresh: the count starts again.
        next: await host.call(caller, "tick", []),
      }).toStrictEqual({ countBefore: 1, cutShort: "app.timed_out", next: 1 });
    } finally {
      held.release();
    }
  });

  it("refuses a call at once with app.busy while as many calls wait as an App takes", async () => {
    const admin = await personApi("admin");
    const desk = await newApp(admin);
    const host = appHost(env, desk);
    const caller = as(admin.userId);
    const held = gate();
    const first = host.call(caller, "keepAndHold", [held.wait]);
    await entered(held, first);
    const waiting = Array.from(
      { length: waitingCallsLimit },
      async () => await host.call(caller, "tick", [])
    );
    const refused = await outcome(host.call(caller, "tick", []));
    held.release();
    expect({
      refused,
      first: await first,
      waiting: await Promise.all(waiting),
    }).toStrictEqual({
      refused: "app.busy",
      first: 1,
      waiting: Array.from({ length: waitingCallsLimit }, (_, at) => at + 2),
    });
  });
});
