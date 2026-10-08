import { appErrorDetailsBytes } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { callApp } from "../src/app.ts";
import { release, requestGranted, serverBuilt } from "./apps.ts";
import { reached } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

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
//   than an error may.
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

  echo(_caller: Caller, value: unknown): unknown {
    return value;
  }

  big(): bigint {
    return 7n;
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
const setUp = async () => {
  const admin = await personApi("admin");
  const { id: collectionId } = await admin.api.knowledge.createCollection({
    name: `Tasks ${unique()}`,
    access: "everyone",
  });
  const desk = await newApp(admin, {
    "app/records.json": taskType(collectionId),
  });
  const front = await newApp(admin);
  const mail = await mailConnection();
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
  await grant(
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
  await grant(front, { type: "app", appId: desk }, ["read", "write"], "DESK");
  // The desk's call of its own export marked `write`, from a read: only
  // the read stops it, never a missing grant.
  const other = await newApp(admin);
  await grant(desk, { type: "app", appId: other }, ["write"], "SELF");
  return { admin, desk, front, mail };
};

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

  it("takes no big integer into a call or out of one, from a screen, a workflow or another App", async () => {
    const admin = await personApi("admin");
    const app = await newApp(admin);
    const screen = { userId: admin.userId, mode: "interactive" } as const;
    const run = {
      userId: admin.userId,
      mode: "workflow",
      idempotencyKey: `${crypto.randomUUID()}:step`,
    } as const;
    expect({
      sent: await outcome(callApp(env, app, screen, "echo", [7n])),
      sentDeep: await outcome(
        callApp(env, app, run, "echo", [{ list: [new Map([["n", 7n]])] }])
      ),
      answered: await outcome(callApp(env, app, screen, "big")),
      plain: await callApp(env, app, screen, "echo", [{ n: 7 }]),
      fromScreen: await outcome(admin.api.screens.call(app, "echo", [7n])),
    }).toStrictEqual({
      sent: "app.call_invalid",
      sentDeep: "app.call_invalid",
      answered: "app.answer_invalid",
      plain: { n: 7 },
      fromScreen: "app.call_invalid",
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
});
