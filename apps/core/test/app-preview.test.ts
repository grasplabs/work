import { appIdSchema, chatIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { callApp } from "../src/app.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import {
  previewUpdateConfirmMs,
  previewUpdateLeaseMs,
} from "../src/preview-updates.ts";
import { readStatistics } from "../src/statistics.ts";
import { openTestRun } from "./agent-chat.ts";
import {
  pastAccessRecheck,
  release,
  requestGranted,
  serverBuilt,
} from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, readCollection } from "./knowledge.ts";
import { mailConnection } from "./mail-connection.ts";
import { appModulesOf, loadFrame } from "./screen-frames.ts";
import { auditedDuring, signedInApi } from "./sign-in.ts";

// A chat's preview of its draft of an App: the draft's screens and server
// code, run for the chat's person with no side effects. These tests start
// from the ways it can fail: the draft's code writes to the App's real
// storage or Knowledge, calls a connection or another App, records a
// statistic, reaches the network, or reads real data it could show; a
// name a permission asked for and not granted gives the preview reaches
// what only a grant allows; a preview keeps what an earlier draft wrote;
// and someone other than the chat's person, or a person who no longer
// builds the App, previews it.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** Runs a promise and says how it ended, by error code; for App code. */
const outcomeCode = `export const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? "failed";
  }
};
`;

/**
 * The App's server code: it keeps notes in its storage. The draft's
 * (`tries`) also tries every binding its permissions give it.
 */
const serverCode = (
  tries: boolean
) => `import { DurableObject } from "cloudflare:workers";

import { outcome } from "./outcome.js";

type Caller = { userId: string; token: string };
const env = (self: DurableObject): Record<string, any> => (self as unknown as { env: Record<string, any> }).env;

export class App extends DurableObject {
  remember(_caller: Caller, note: string): string[] {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notes (note TEXT)");
    this.ctx.storage.sql.exec("INSERT INTO notes VALUES (?)", note);
    return this.notes();
  }

  notes(): string[] {
    const found = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE name = 'notes'")
      .toArray();
    if (found.length === 0) {
      return [];
    }
    return this.ctx.storage.sql.exec("SELECT note FROM notes").toArray().map((row) => String(row.note));
  }

  envNames(): string[] {
    return Object.keys(env(this)).toSorted();
  }

  tables(): string[] {
    return this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => String(row.name))
      .filter((name) => !name.startsWith("_cf") && !name.startsWith("sqlite"));
  }
${
  tries
    ? `
  async tries(caller: Caller, documentId: string): Promise<Record<string, unknown>> {
    const { MAIL, ARCHIVE, GUESTS, HANDBOOK, LEDGER, STATISTICS } = env(this);
    const listed = await HANDBOOK.listDocuments(caller);
    const guests = await GUESTS.list(caller);
    const found = await HANDBOOK.search(caller, "note");
    const stats = await STATISTICS.read(caller, { measure: "opened", days: 1, where: {} });
    return {
      mail: await outcome(MAIL.call(caller, "mail.send", { to: "ben@acme.test", subject: "Hi" }, { idempotencyKey: "k" })),
      archive: await outcome(ARCHIVE.call(caller, "mail.send", { to: "ben@acme.test", subject: "Hi" }, { idempotencyKey: "k" })),
      listed: listed.documents.length,
      found: found.hits.length,
      read: await outcome(HANDBOOK.getDocument(caller, documentId)),
      section: await outcome(HANDBOOK.read(caller, documentId)),
      ledger: await outcome(LEDGER.call(caller, "book", {})),
      point: await outcome(STATISTICS.record(caller, { measure: "opened", value: 1 })),
      stats: stats.groups.length,
      invite: await outcome(GUESTS.invite(caller, { name: "Ann", skill: "interview" })),
      guests: guests.length,
      guest: await outcome(GUESTS.read(caller, "guest-1")),
      revoke: await outcome(GUESTS.revoke(caller, "guest-1")),
      fetch: await outcome(fetch("https://example.com/")),
    };
  }

  fail(): never {
    throw new Error("Invoice 7 has no total");
  }

  async kinds(caller: Caller): Promise<string[]> {
    const { MAIL, HANDBOOK, LEDGER, STATISTICS } = env(this);
    const said = async (call: () => Promise<unknown>): Promise<string> => {
      try {
        await call();
        return "ok";
      } catch (error) {
        return String((error as Error).message);
      }
    };
    return [
      await said(() => MAIL.listDocuments(caller)),
      await said(() => HANDBOOK.call(caller, "mail.send", {})),
      await said(() => LEDGER.record(caller, {})),
      await said(() => STATISTICS.getDocument(caller, "note")),
    ];
  }

  #watcher: ((value: number) => Promise<void>) | undefined;
  #pushed = 0;
  #stopped = "no";

  watch(_caller: Caller, onChange: { dup(): (value: number) => Promise<void> }): string {
    this.#watcher = onChange.dup();
    const push = async (): Promise<void> => {
      try {
        this.#pushed += 1;
        await this.#watcher?.(this.#pushed);
        setTimeout(push, 50);
      } catch (error) {
        this.#stopped = (error as { code?: string }).code ?? "failed";
      }
    };
    void push();
    return "watching";
  }

  stopped(): string {
    return this.#stopped;
  }

  async slow(_caller: Caller, entered: (value: string) => Promise<void>): Promise<string> {
    await entered("in");
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return "done";
  }
`
    : ""
}}
`;

const screen = `export default function Desk() {
  return <main>Desk</main>;
}
`;

/** The App as released: notes in its storage, and a screen. */
const released = {
  "app/server.ts": serverCode(false),
  "app/outcome.ts": outcomeCode,
  "screens/desk.tsx": screen,
};

/** A new App of `builder`'s, released and built ahead. */
const newApp = async (
  builder: Person,
  name: string,
  files: Record<string, string>
): Promise<AppId> => {
  const { id } = await builder.api.apps.create({ name });
  await serverBuilt(id, await release(builder, id, files));
  return appIdSchema.parse(id);
};

/** The Workspace object that holds `person`'s chats. */
const chatsOf = (person: Person) =>
  workspace(env, personalWorkspaceId(person.userId));

/**
 * `person`'s new chat, with a draft of `app` over version 1 whose files
 * are `changes`, as the chat's agent writes one; returns its revision.
 */
const chatWithDraft = async (
  person: Person,
  app: AppId,
  changes: Record<string, string | null>
) => {
  const chat = await person.api.chats.create("Build");
  const chatId = chatIdSchema.parse(chat.id);
  const write = async (
    written: Record<string, string | null>,
    revision: number
  ) => {
    const saved = await chatsOf(person).saveDraft(
      chatId,
      app,
      1,
      written,
      [],
      revision,
      await openTestRun(chatsOf(person), chatId)
    );
    if (!saved) {
      throw new Error("The draft wasn't written");
    }
    return revision + 1;
  };
  return { chatId, revision: await write(changes, 0), write };
};

/**
 * An App with a mail connection (`MAIL`), a collection with a note
 * (`HANDBOOK`) and another App's exports (`LEDGER`), each granted by an
 * admin, the same mail connection (`ARCHIVE`) and guest chats
 * (`GUESTS`) asked for and not granted, and a draft of it in a chat of
 * its builder's.
 */
const setUp = async () => {
  const admin = await signedInApi(idp, "admin");
  const builder = await signedInApi(idp, "builder");
  const app = await newApp(builder, "Invoice desk", released);
  const ledger = await newApp(admin, "Ledger", {
    "app/server.ts": `import { DurableObject } from "cloudflare:workers";\n\nexport class App extends DurableObject {\n  book(): string {\n    return "booked";\n  }\n}\n`,
    "app/exports.json": JSON.stringify({
      book: {
        access: "write",
        description: "Books an invoice",
        input: { type: "object" },
        output: { type: "string" },
      },
    }),
  });
  const mail = await mailConnection();
  const subject = { type: "app", appId: app } as const;
  await requestGranted(idp, admin, {
    subject,
    object: { type: "connection", connectionId: mail.id },
    actions: ["mail.send"],
    binding: "MAIL",
  });
  const { collectionId, noteId } = await collectionWithNote(admin.api, {
    name: "Handbook",
    access: "everyone",
  });
  await requestGranted(idp, admin, readCollection(subject, collectionId));
  await requestGranted(idp, admin, {
    subject,
    object: { type: "app", appId: ledger },
    actions: ["write"],
    binding: "LEDGER",
  });
  // Asked for, as the agent does for a new App, and granted by nobody.
  await builder.api.permissions.request({
    subject,
    object: { type: "connection", connectionId: mail.id },
    actions: ["mail.send"],
    binding: "ARCHIVE",
  });
  await builder.api.permissions.request({
    subject,
    object: { type: "platform" },
    actions: ["guests"],
    binding: "GUESTS",
  });
  const draft = await chatWithDraft(builder, app, {
    "app/server.ts": serverCode(true),
  });
  return { admin, builder, app, mail, noteId, ...draft };
};

/** A preview's outcome: `loaded`, or the code it was refused with. */
const named = (outcome: unknown): unknown =>
  typeof outcome === "string" ? outcome : "loaded";

/** What a call answered, or the code of the error it failed with. */
const answer = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    return await promise;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error
      ? error.code
      : String(error);
  }
};

/**
 * Runs `during` with every read of core's files held until it calls
 * `release`: a preview's load (which reads the draft's base version) waits
 * there for as long as the test needs. `calls` names each call to core's
 * files made since the release. Set back however it ends.
 */
const heldReadsDuring = async <T>(
  during: (letGo: () => void, calls: string[]) => Promise<T>
): Promise<T> => {
  const { FILES: files } = env;
  const gate = Promise.withResolvers<boolean>();
  let open = false;
  const calls: string[] = [];
  env.FILES = new Proxy(files, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (typeof property === "string" && typeof value === "function") {
        return async (...args: unknown[]): Promise<unknown> => {
          if (open) {
            calls.push(property);
          } else if (property === "get") {
            await gate.promise;
          }
          return await Reflect.apply(value, target, args);
        };
      }
      return value;
    },
  });
  const letGo = () => {
    open = true;
    gate.resolve(true);
  };
  try {
    return await during(letGo, calls);
  } finally {
    letGo();
    env.FILES = files;
  }
};

describe("previewing a chat's draft", { timeout: 120_000 }, () => {
  it("runs the draft's screens and server code in a database of its own, dropped when the draft changes", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const { chats } = builder.api;
    const call = async (at: number, method: string, args: unknown[] = []) =>
      await answer(chats.previewCall(chatId, app, at, method, args));
    const appNotes = async () =>
      await callApp(
        env,
        app,
        { userId: builder.userId, mode: "interactive" },
        "notes"
      );

    const bundle = await chats.preview(chatId, app);
    const first = {
      remembered: await call(revision, "remember", ["draft"]),
      // Its database is its own: none of the chats kept next to it.
      tables: await call(revision, "tables"),
      // The App's own storage has none of it.
      appNotes: await appNotes(),
    };
    // A restart of the object that holds the chat starts it afresh.
    await runInDurableObject(chatsOf(builder), (_instance, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });
    const restarted = await call(revision, "notes");
    await call(revision, "remember", ["again"]);
    // A write drops the preview of the revision before: a call for it is
    // refused, and the new revision starts with an empty database.
    const next = await write({ "screens/list.tsx": screen }, revision);
    const changed = {
      earlier: await call(revision, "notes"),
      notes: await call(next, "notes"),
      bundle: await chats.preview(chatId, app, "list"),
      // An error of the draft's code comes back as an App's does.
      failed: await call(next, "fail"),
    };

    expect({
      bundle,
      // Its frame runs the draft's own build.
      modules: appModulesOf(
        (await loadFrame(bundle)) ?? {
          modules: {},
        }
      ).includes("app~screens~desk.js"),
      first,
      restarted,
      changed,
    }).toMatchObject({
      bundle: {
        app,
        name: "Invoice desk",
        revision,
        screen: "desk",
        screens: ["desk"],
      },
      modules: true,
      first: { remembered: ["draft"], tables: ["notes"], appNotes: [] },
      restarted: [],
      changed: {
        earlier: "app.preview_outdated",
        notes: [],
        bundle: { revision: next, screen: "list", screens: ["desk", "list"] },
        failed: "app.failed",
      },
    });
  });

  it("never writes, calls out or reads real data, under the names the App's permissions give, granted or only asked for", async () => {
    const { builder, app, mail, noteId, chatId, revision } = await setUp();
    const { chats } = builder.api;
    const asBuilder = {
      userId: builder.userId,
      mode: "interactive",
    } as const;

    const names = {
      preview: await chats.previewCall(chatId, app, revision, "envNames", []),
      app: await callApp(env, app, asBuilder, "envNames"),
    };
    let tried: unknown;
    const events = await auditedDuring(async () => {
      tried = await chats.previewCall(chatId, app, revision, "tries", [noteId]);
    });
    const stats = await readStatistics(
      env,
      {
        subject: { type: "app", appId: app },
        onBehalfOf: builder.userId,
        mode: "interactive",
        appVersion: 1,
      },
      { measure: "opened", days: 1, where: {} }
    );

    const refused = "app.preview_side_effect";
    expect({
      names,
      tried,
      // Nothing reached the mail server, nothing was held for the person,
      // no statistic was recorded, and nothing was audited: nothing
      // happened.
      mail: await mail.did(),
      held: await builder.api.pendingActions.list(),
      stats: stats.groups,
      events,
    }).toStrictEqual({
      names: {
        // What the App asked for and wasn't granted has a name in the
        // preview only, so the draft's code runs as written; the App's
        // own env has it once an admin grants it.
        preview: [
          "ARCHIVE",
          "GUESTS",
          "HANDBOOK",
          "LEDGER",
          "MAIL",
          "STATISTICS",
        ],
        app: ["HANDBOOK", "LEDGER", "MAIL", "STATISTICS"],
      },
      tried: {
        mail: refused,
        archive: refused,
        listed: 0,
        found: 0,
        read: "knowledge.not_found",
        section: "knowledge.not_found",
        ledger: refused,
        point: "ok",
        stats: 0,
        // No guest is invited (a link anyone could open), and none is there.
        invite: refused,
        guests: 0,
        guest: "guest.not_found",
        revoke: refused,
        fetch: "failed",
      },
      mail: { calls: 0, sent: [] },
      held: [],
      stats: [],
      events: [],
    });
  });

  it("is only for the chat's person, while they build the App", async () => {
    const { admin, builder, app, chatId, revision } = await setUp();
    const [stranger, user] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
    ]);
    await admin.api.apps.members.add(app, {
      type: "person",
      id: stranger.userId,
      role: "builder",
    });
    await admin.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const empty = await builder.api.chats.create("Nothing yet");
    const theirs = await chatWithDraft(user, app, { "notes.md": "theirs" });
    const both = async (
      person: Person,
      chat: string,
      at: number
    ): Promise<unknown[]> => [
      await answer(person.api.chats.preview(chat, app)),
      await answer(person.api.chats.previewCall(chat, app, at, "notes", [])),
    ];

    const refusals = {
      // Someone else's chat is no chat of theirs, whatever their role.
      strangers: await both(stranger, chatId, revision),
      // A chat with no draft of the App has nothing to preview.
      empty: await both(builder, empty.id, 1),
      // Someone who only uses the App: not even a draft in their own chat.
      user: await both(user, theirs.chatId, theirs.revision),
    };

    expect(refusals).toStrictEqual({
      strangers: ["agent.chat_not_found", "agent.chat_not_found"],
      empty: ["app.no_draft", "app.no_draft"],
      user: ["role.forbidden", "role.forbidden"],
    });
  });

  it("fails a call of a method its binding doesn't have as that call fails live", async () => {
    const { admin, builder, app, chatId, revision } = await setUp();
    // The same code as the App's own: the live answers to compare with.
    // Made current by an admin, so what the App was granted stays granted
    // and its own env has each binding too.
    await serverBuilt(
      app,
      await release(admin, app, { "app/server.ts": serverCode(true) })
    );

    const preview = await builder.api.chats.previewCall(
      chatId,
      app,
      revision,
      "kinds",
      []
    );
    const live = await callApp(
      env,
      app,
      { userId: builder.userId, mode: "interactive" },
      "kinds"
    );
    // A connection has no `listDocuments`, a collection no `call`, another
    // App's exports no `record`, statistics no `getDocument`.
    expect({ preview, live }).toStrictEqual({
      preview: live,
      live: ["listDocuments", "call", "record", "getDocument"].map(
        (method) => `The RPC receiver does not implement "${method}".`
      ),
    });
  });

  it("says which of its paths a draft deletes, and previews no screen it deleted", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await newApp(builder, "Invoice desk", released);
    const { chatId } = await chatWithDraft(builder, app, {
      "screens/desk.tsx": null,
      "screens/list.tsx": screen,
    });
    const { chats } = builder.api;

    const [draft] = await chats.drafts(chatId);
    const first = await chats.preview(chatId, app);

    expect({
      changed: draft?.changed,
      deleted: draft?.deleted,
      first: { screen: first.screen, screens: first.screens },
      gone: await answer(chats.preview(chatId, app, "desk")),
    }).toStrictEqual({
      changed: ["screens/desk.tsx", "screens/list.tsx"],
      deleted: ["screens/desk.tsx"],
      first: { screen: "list", screens: ["list"] },
      gone: "screen.not_found",
    });
  });

  it("answers a call the draft's next write stops as out of date, not as the draft's failure", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const { chats } = builder.api;
    const entered = Promise.withResolvers<boolean>();

    const slow = answer(
      chats.previewCall(chatId, app, revision, "slow", [
        () => {
          entered.resolve(true);
        },
      ])
    );
    await entered.promise;
    await write({ "screens/list.tsx": screen }, revision);

    await expect(slow).resolves.toBe("app.preview_outdated");
  });

  it("stops a preview's callbacks once their person no longer builds the App", async () => {
    const { admin, app } = await setUp();
    const other = await signedInApi(idp, "builder");
    const role = async (member: "builder" | "user") => {
      await admin.api.apps.members.add(app, {
        type: "person",
        id: other.userId,
        role: member,
      });
    };
    await role("builder");
    const { chats } = other.api;

    /** Watches pushes in a chat of theirs, then takes away what `lose` does. */
    const stopsWhen = async (
      lose: () => Promise<void>,
      restore: () => Promise<void>
    ) => {
      const draft = await chatWithDraft(other, app, {
        "app/server.ts": serverCode(true),
      });
      const received: unknown[] = [];
      await chats.previewCall(draft.chatId, app, draft.revision, "watch", [
        (value: unknown) => {
          received.push(value);
        },
      ]);
      await vi.waitFor(() => {
        expect(received.length).toBeGreaterThan(1);
      });
      await lose();
      // Past the time one answer holds: the next push checks again, and is
      // refused, and every one after.
      await pastAccessRecheck(async () => {
        await vi.waitFor(
          async () => {
            const before = received.length;
            await scheduler.wait(300);
            expect(received).toHaveLength(before);
          },
          { timeout: 5000, interval: 0 }
        );
      });
      await restore();
      const stopped = await chats.previewCall(
        draft.chatId,
        app,
        draft.revision,
        "stopped",
        []
      );
      return stopped;
    };

    const unshared = await stopsWhen(
      async () => {
        await role("user");
      },
      async () => {
        await role("builder");
      }
    );
    // Each push was refused by core, as a screen's is once its person may
    // no longer use the App.
    expect(unshared).toBe("app.not_found");
  });

  it("loads one update of a preview at a time, keeping the newest waiting and refusing the one it replaces", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await newApp(builder, "Invoice desk", released);
    const { chatId } = await chatWithDraft(builder, app, {
      "screens/list.tsx": screen,
    });
    const { chats } = builder.api;
    /** `count` loads at once, the first held at its read until `releaseWhen` says. */
    const loadedAtOnce = async (
      count: number,
      releaseWhen: (outcomes: Promise<unknown>[]) => Promise<unknown>
    ): Promise<unknown[]> =>
      await heldReadsDuring(async (letGo) => {
        const outcomes = Array.from(
          { length: count },
          async () => await answer(chats.preview(chatId, app))
        );
        await releaseWhen(outcomes);
        letGo();
        const settled = await Promise.all(outcomes);
        return settled
          .map(named)
          .toSorted((a, b) => String(a).localeCompare(String(b)));
      });

    expect({
      // One loads and one waits for it: both load.
      two: await loadedAtOnce(2, async () => {
        await scheduler.wait(300);
      }),
      // The third replaces the one waiting: that refusal comes first, while
      // the first load is still held.
      three: await loadedAtOnce(
        3,
        async (outcomes) => await Promise.race(outcomes)
      ),
    }).toStrictEqual({
      two: ["loaded", "loaded"],
      three: ["app.preview_superseded", "loaded", "loaded"],
    });
  });

  it("frees the place of an update that never settles once its lease is over, waking the one waiting by itself", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await newApp(builder, "Invoice desk", released);
    const { chatId } = await chatWithDraft(builder, app, {
      "screens/list.tsx": screen,
    });
    const started = Date.parse("2026-10-20T09:00:00Z");

    const outcome = await runInDurableObject(
      chatsOf(builder),
      async (instance) => {
        const take = async () =>
          await instance.takePreviewUpdate(chatId, builder.userId, app);
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(started);
        try {
          // Taken, and never settled: its isolate went away mid-load.
          await take();
          vi.setSystemTime(started + previewUpdateLeaseMs);
          let next = "waiting";
          const waiting = take().then((token) => {
            next = token === null ? "superseded" : "loading";
            return token;
          });
          await scheduler.wait(50);
          const atLease = next;
          // A millisecond past, nothing else happens: its own wait wakes it.
          vi.setSystemTime(started + previewUpdateLeaseMs + 1);
          await waiting;
          return { atLease, past: next };
        } finally {
          vi.useRealTimers();
        }
      }
    );

    // Exactly at its lease the stuck update still holds its place.
    expect(outcome).toStrictEqual({ atLease: "waiting", past: "loading" });
  });

  it("refuses the waiting update a newer one replaces, and loads the newer one next", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await newApp(builder, "Invoice desk", released);
    const { chatId } = await chatWithDraft(builder, app, {
      "screens/list.tsx": screen,
    });

    const outcome = await runInDurableObject(
      chatsOf(builder),
      async (instance) => {
        const take = async () =>
          await instance.takePreviewUpdate(chatId, builder.userId, app);
        const settle = (token: string | null) => {
          instance.settlePreviewUpdate(
            chatId,
            builder.userId,
            app,
            token ?? ""
          );
        };
        const order: string[] = [];
        const loading = await take();
        const older = take().then((token) => {
          order.push(token === null ? "older superseded" : "older loads");
          return token;
        });
        const newer = take().then((token) => {
          order.push(token === null ? "newer superseded" : "newer loads");
          return token;
        });
        await older;
        order.push("first settles");
        settle(loading);
        settle(await newer);
        // Settled, the session is free again: the next loads at once.
        const free = await take();
        settle(free);
        return { order, free: free !== null };
      }
    );

    expect(outcome).toStrictEqual({
      order: ["older superseded", "first settles", "newer loads"],
      free: true,
    });
  });

  it("frees the place of an update that waited and whose caller never confirms it, soon", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await newApp(builder, "Invoice desk", released);
    const { chatId } = await chatWithDraft(builder, app, {
      "screens/list.tsx": screen,
    });
    const started = Date.parse("2026-10-20T09:00:00Z");

    const outcome = await runInDurableObject(
      chatsOf(builder),
      async (instance) => {
        const take = async () =>
          await instance.takePreviewUpdate(chatId, builder.userId, app);
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(started);
        try {
          const first = await take();
          // Its caller went away while it waited: given the place, it
          // never confirms it.
          const abandoned = take();
          instance.settlePreviewUpdate(
            chatId,
            builder.userId,
            app,
            first ?? ""
          );
          await abandoned;
          let next = "waiting";
          const waiting = take().then((token) => {
            next = token === null ? "superseded" : "loading";
            return token;
          });
          vi.setSystemTime(started + previewUpdateConfirmMs);
          await scheduler.wait(50);
          const atLimit = next;
          vi.setSystemTime(started + previewUpdateConfirmMs + 1);
          await waiting;
          // Its caller, slow and not gone after all, may not load now.
          const late = instance.confirmPreviewUpdate(
            chatId,
            builder.userId,
            app,
            (await abandoned) ?? ""
          );
          return { atLimit, past: next, late };
        } finally {
          vi.useRealTimers();
        }
      }
    );

    expect(outcome).toStrictEqual({
      atLimit: "waiting",
      past: "loading",
      late: false,
    });
  });

  it("keeps a confirmed update's place for its whole lease", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await newApp(builder, "Invoice desk", released);
    const { chatId } = await chatWithDraft(builder, app, {
      "screens/list.tsx": screen,
    });
    const started = Date.parse("2026-10-20T09:00:00Z");

    const outcome = await runInDurableObject(
      chatsOf(builder),
      async (instance) => {
        const take = async () =>
          await instance.takePreviewUpdate(chatId, builder.userId, app);
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(started);
        try {
          const first = await take();
          const waited = take();
          instance.settlePreviewUpdate(
            chatId,
            builder.userId,
            app,
            first ?? ""
          );
          const confirmed = instance.confirmPreviewUpdate(
            chatId,
            builder.userId,
            app,
            (await waited) ?? ""
          );
          let next = "waiting";
          void take().then((token) => {
            next = token === null ? "superseded" : "loading";
            return token;
          });
          vi.setSystemTime(started + previewUpdateConfirmMs + 1);
          await scheduler.wait(50);
          return { confirmed, next };
        } finally {
          vi.useRealTimers();
        }
      }
    );

    expect(outcome).toStrictEqual({ confirmed: true, next: "waiting" });
  });

  it("settles nothing with a token from before the object restarted", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await newApp(builder, "Invoice desk", released);
    const { chatId } = await chatWithDraft(builder, app, {
      "screens/list.tsx": screen,
    });
    const before = await runInDurableObject(
      chatsOf(builder),
      async (instance) =>
        await instance.takePreviewUpdate(chatId, builder.userId, app)
    );
    await runInDurableObject(chatsOf(builder), (_instance, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });

    const outcome = await runInDurableObject(
      chatsOf(builder),
      async (instance) => {
        const take = async () =>
          await instance.takePreviewUpdate(chatId, builder.userId, app);
        const loading = await take();
        // The load from before the restart ends late.
        instance.settlePreviewUpdate(chatId, builder.userId, app, before ?? "");
        let next = "waiting";
        const waiting = take().then((token) => {
          next = token === null ? "superseded" : "loading";
          return token;
        });
        await scheduler.wait(50);
        const afterOld = next;
        instance.settlePreviewUpdate(
          chatId,
          builder.userId,
          app,
          loading ?? ""
        );
        await waiting;
        return { afterOld, afterOwn: next };
      }
    );

    expect(outcome).toStrictEqual({ afterOld: "waiting", afterOwn: "loading" });
  });

  it("stops a load that outlives its time before it builds, and frees its place", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await newApp(builder, "Invoice desk", released);
    const { chatId } = await chatWithDraft(builder, app, {
      "screens/list.tsx": screen,
    });
    const { chats } = builder.api;

    env.PREVIEW_LOAD_MS = "500";
    try {
      const outcome = await heldReadsDuring(async (letGo, calls) => {
        // Its read of the draft's base stalls past its time.
        const stalled = await answer(chats.preview(chatId, app));
        letGo();
        // Let go, the read finishes: nothing is built or staged after it.
        await scheduler.wait(2000);
        return {
          stalled,
          after: calls.filter((method) => method !== "get"),
        };
      });
      expect({
        ...outcome,
        next: named(await answer(chats.preview(chatId, app))),
      }).toStrictEqual({
        stalled: "screen.build_slow",
        after: [],
        next: "loaded",
      });
    } finally {
      delete env.PREVIEW_LOAD_MS;
    }
  });
});
