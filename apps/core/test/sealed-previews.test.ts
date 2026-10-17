import { sha256Hex } from "@grasp-os/shared/encoding";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalText } from "@grasp-os/shared/json";
import { screenLimits } from "@grasp-os/shared/screens";
import type { QuerySnapshotPush } from "@grasp-os/shared/screens";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import { openStore } from "../src/data-stores.ts";
import { openTestRun } from "./agent-chat.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  chatsOf,
  chatWithDraft,
  keptManifestSchema,
  outcome,
  outcomeOfText,
  previewStores,
  requestFor,
} from "./previews.ts";
import { appModulesOf, loadFrame } from "./screen-frames.ts";
import { calledAs, failure } from "./sealed-apps.ts";
import { auditedDuring, signedInApi } from "./sign-in.ts";

// A chat's preview of its draft of an App of spec 8's layout
// (sealed-previews.ts): the draft sealed into a draft release, and every
// call of its screens, its live queries and the chat's agent run on it
// through the operation host, on a store of the preview's own. These
// tests start from the ways it can fail (the threat model on GRA-652):
// the draft reads or writes the App's data, reaches an outside system,
// runs code that wasn't sealed or changed since, is taken for a version's
// release, is used by someone else or once its person no longer builds
// the App, outlives its draft, or leaks one preview's data into another's.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** The App's notes, its functions and a screen that reads them live. */
const notesFiles = (marker: string): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string().min(1).max(200) }),
});
`,
  "operations/notes.ts": `import { paginationOptionsValidator, paginationResultValidator, resource, v } from "@grasp-os/sdk";
import { action, doc, mutation, query } from "#grasp/server";

// ${marker}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const writer = resource.model("writer", { maxOutputTokens: 100 });

export const create = mutation({
  args: { title: v.string().min(1).max(200) },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const titles = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).map((note) => note.title).sort(),
});

/** The notes, page by page: what a screen's \`usePaginatedQuery\` reads. */
export const list = query({
  args: { pagination: paginationOptionsValidator },
  returns: paginationResultValidator(doc("notes")),
  handler: async (ctx, args) => await ctx.db.query("notes").paginate(args.pagination),
});

/** Writes once a wait is over: its draft may have changed meanwhile. */
export const late = action({
  args: {},
  returns: v.null(),
  uses: [create],
  handler: async (ctx) => {
    await wait(3000);
    await ctx.runMutation(create, { title: "too late" });
    return null;
  },
});

/** Asks the App's model: an outside system. */
export const consult = action({
  args: {},
  returns: v.string(),
  uses: [writer],
  handler: async (ctx) => await ctx.resources.writer.generate({ prompt: "Hi" }),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { consult, create, late, list, titles, writer } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "appMembers", write: "appMembers" } } },
  operations: { notes: { create, titles, late, consult, list } },
  internalOperations: {},
  screens: [],
  uses: [writer],
});
`,
  "screens/desk.tsx": `import { useQuery } from "@grasp-os/sdk/react";
import { api } from "#grasp";

export default function Desk() {
  const titles = useQuery(api.notes.titles, {});
  return <main>{titles === undefined ? "Loading" : titles.join(", ")}</main>;
}
`,
});

/** A new App of `builder`'s, its notes released, sealed and current. */
const notesApp = async (builder: Person): Promise<AppId> => {
  const { id } = await builder.api.apps.create({ name: "Notes" });
  await release(builder, id, notesFiles("released"));
  return appIdSchema.parse(id);
};

/** The draft of `app` in a chat of the App's builder, and the App itself. */
const setUp = async () => {
  const builder = await signedInApi(idp, "builder");
  const app = await notesApp(builder);
  const draft = await chatWithDraft(builder, app, {
    "operations/notes.ts": notesFiles("drafted")["operations/notes.ts"] ?? "",
  });
  return { builder, app, ...draft };
};

/** The release a preview call's answer says ran, or null. */
const answerHashOf = (answer: unknown): string | null => {
  const hash: unknown =
    typeof answer === "object" && answer !== null
      ? Reflect.get(answer, "manifestHash")
      : null;
  return typeof hash === "string" ? hash : null;
};

describe("previewing a draft of spec 8's layout", { timeout: 180_000 }, () => {
  it("runs the draft's functions on its draft release, on a store of its own, and changes none of the App's data", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const { chats } = builder.api;
    const asBuilder = {
      userId: builder.userId,
      role: "builder" as const,
      teams: [],
    };
    await calledAs(
      asBuilder,
      app,
      { contractId: "notes.create", kind: "mutation" },
      {
        title: "live",
      }
    );

    const call = async (at: number, path: string, input: unknown = {}) =>
      outcome(
        await chats.previewFunction(
          chatId,
          app,
          at,
          await requestFor(builder, { chatId, app, revision: at }, path, input)
        )
      );
    // The screen builds with the references its draft release generates.
    const bundle = await chats.preview(chatId, app);
    const first = {
      created: typeof (await call(revision, "notes.create", {
        title: "draft",
      })),
      // It reads the preview's notes, none of the App's.
      preview: await call(revision, "notes.titles"),
      app: await calledAs(asBuilder, app, {
        contractId: "notes.titles",
        kind: "query",
      }),
    };
    const [kept] = await previewStores(builder, chatId, app);
    // The preview's store is no store of the inventory's.
    const opened = await failure(
      async () => await openStore(env, kept?.store_id ?? "")
    );
    // The draft release is the release of no version of the App's.
    const sealed = await failure(async () => await loadRelease(env, app, 2));

    // A write starts the next revision on a new, empty store; a call of
    // the revision before is out of date.
    const stale = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.titles"
    );
    const next = await write(
      {
        "operations/notes.ts": notesFiles("again")["operations/notes.ts"] ?? "",
      },
      revision
    );
    const changed = {
      earlier: await failure(
        async () => await chats.previewFunction(chatId, app, revision, stale)
      ),
      notes: await call(next, "notes.titles"),
    };
    await vi.waitFor(async () => {
      // The store of the revision before is discarded and forgotten.
      const stores = await previewStores(builder, chatId, app);
      expect(stores.map((row) => row.revision)).toStrictEqual([next]);
    });

    expect({
      modules: appModulesOf(
        (await loadFrame(bundle)) ?? { modules: {} }
      ).includes("app~screens~desk.js"),
      first,
      opened,
      sealed,
      changed,
    }).toStrictEqual({
      modules: true,
      first: {
        created: "string",
        preview: ["draft"],
        app: { ok: true, value: ["live"] },
      },
      opened: "data.store_unavailable",
      sealed: "version.not_sealed",
      changed: { earlier: "app.preview_outdated", notes: [] },
    });
  });

  it("reaches no outside system: every resource request is refused, and nothing is audited", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const request = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.consult"
    );
    let answer: unknown;
    const events = await auditedDuring(async () => {
      answer = await builder.api.chats.previewFunction(
        chatId,
        app,
        revision,
        request
      );
    });
    expect({ consulted: outcome(answer), events }).toStrictEqual({
      consulted: "resource.unavailable",
      events: [],
    });
  });

  it("runs only what was sealed: a kept artifact changed since is refused", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const request = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.titles"
    );
    const before = outcome(
      await builder.api.chats.previewFunction(chatId, app, revision, request)
    );
    // Someone changes a kept module, and the object starts again, so the
    // release is loaded back from what is kept.
    await runInDurableObject(chatsOf(builder), (_instance, state) => {
      // One of the App's own modules, not the contracts, which are
      // checked against the manifest anyway.
      const [kept] = state.storage.sql
        .exec<{ manifest: string }>(
          "SELECT manifest FROM preview_releases WHERE chat_id = ?",
          chatId
        )
        .toArray();
      const module = keptManifestSchema
        .parse(JSON.parse(kept?.manifest ?? "null"))
        .artifacts.find(({ path }) => path.startsWith("modules/"));
      state.storage.sql.exec(
        "UPDATE preview_release_artifacts SET content = content || ' ' WHERE chat_id = ? AND sha256 = ?",
        chatId,
        module?.sha256 ?? ""
      );
    });
    await runInDurableObject(chatsOf(builder), (_instance, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });
    const after = outcome(
      await builder.api.chats.previewFunction(chatId, app, revision, request)
    );
    expect({ before, after }).toStrictEqual({
      before: [],
      after: "version.artifact_corrupt",
    });
  });

  it("never runs a draft of spec 8's layout as v1 server code, whatever server code it has", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { chatId, revision } = await chatWithDraft(builder, app, {
      "app/server.ts": `import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  ran(): string {
    return "ran as v1";
  }
}
`,
    });
    const called = await failure(
      async () =>
        await builder.api.chats.previewCall(chatId, app, revision, "ran", [])
    );
    const asAgent = await failure(
      async () =>
        await chatsOf(builder).callDraftFunction(
          chatId,
          builder.userId,
          app,
          "ran",
          {}
        )
    );
    expect({ called, asAgent }).toStrictEqual({
      called: "app.method_invalid",
      asAgent: "operation.not_found",
    });
  });

  it("commits nothing once its draft changed under a call already running", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const request = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.late"
    );
    const late = builder.api.chats.previewFunction(
      chatId,
      app,
      revision,
      request
    );
    // The call is under way, waiting to write.
    await scheduler.wait(1000);
    const next = await write(
      {
        "operations/notes.ts": notesFiles("again")["operations/notes.ts"] ?? "",
      },
      revision
    );
    expect({
      late: outcome(await late),
      notes: outcome(
        await builder.api.chats.previewFunction(
          chatId,
          app,
          next,
          await requestFor(
            builder,
            { chatId, app, revision: next },
            "notes.titles"
          )
        )
      ),
    }).toStrictEqual({ late: "app.preview_outdated", notes: [] });
  });

  it("is only for the chat's person while they build the App, checked again at every call", async () => {
    const owner = await signedInApi(idp, "builder");
    const app = await notesApp(owner);
    const [other, stranger] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
    ]);
    for (const person of [other, stranger]) {
      // oxlint-disable-next-line no-await-in-loop -- one member after the other
      await owner.api.apps.members.add(app, {
        type: "person",
        id: person.userId,
        role: "builder",
      });
    }
    const { chatId, revision } = await chatWithDraft(other, app, {
      "operations/notes.ts": notesFiles("drafted")["operations/notes.ts"] ?? "",
    });
    const request = await requestFor(
      other,
      { chatId, app, revision },
      "notes.create",
      { title: "kept" }
    );
    const theirs = await failure(
      async () =>
        await stranger.api.chats.previewFunction(chatId, app, revision, request)
    );
    // No longer a builder, they call the chat's object straight away, past
    // core's check of the role: its own gate refuses the call.
    await owner.api.apps.members.add(app, {
      type: "person",
      id: other.userId,
      role: "user",
    });
    const demoted = outcomeOfText(
      await chatsOf(other).previewFunction(
        chatId,
        other.userId,
        app,
        revision,
        request
      )
    );
    expect({ theirs, demoted }).toStrictEqual({
      theirs: "agent.chat_not_found",
      demoted: "role.forbidden",
    });
  });

  it("keeps a live query of the preview fresh, and ends it once the draft changes", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const { chats } = builder.api;
    const pushed: QuerySnapshotPush[] = [];
    await chats.previewWatchQuery(
      chatId,
      app,
      revision,
      await requestFor(builder, { chatId, app, revision }, "notes.titles"),
      (snapshot) => {
        pushed.push(snapshot);
      }
    );
    await vi.waitFor(() => {
      expect(pushed.at(-1)?.result).toStrictEqual({ ok: true, value: [] });
    });
    await chats.previewFunction(
      chatId,
      app,
      revision,
      await requestFor(builder, { chatId, app, revision }, "notes.create", {
        title: "fresh",
      })
    );
    await vi.waitFor(() => {
      expect(pushed.at(-1)?.result).toStrictEqual({
        ok: true,
        value: ["fresh"],
      });
    });
    const next = await write(
      {
        "operations/notes.ts": notesFiles("again")["operations/notes.ts"] ?? "",
      },
      revision
    );
    // The query of the revision before is let go of: nothing of the next
    // revision's store reaches it.
    await chats.previewFunction(
      chatId,
      app,
      next,
      await requestFor(
        builder,
        { chatId, app, revision: next },
        "notes.create",
        { title: "newer" }
      )
    );
    await scheduler.wait(2000);
    expect(
      pushed.filter(({ result }) => JSON.stringify(result).includes("newer"))
    ).toStrictEqual([]);
  });

  it("forgets its draft release and discards its stores once the draft is dropped, and again once the chat goes", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const { chats } = builder.api;
    await chats.previewFunction(
      chatId,
      app,
      revision,
      await requestFor(builder, { chatId, app, revision }, "notes.create", {
        title: "kept",
      })
    );
    const kept = async () =>
      await runInDurableObject(chatsOf(builder), (_instance, state) => ({
        releases: state.storage.sql
          .exec("SELECT 1 FROM preview_releases WHERE chat_id = ?", chatId)
          .toArray().length,
        artifacts: state.storage.sql
          .exec(
            "SELECT 1 FROM preview_release_artifacts WHERE chat_id = ?",
            chatId
          )
          .toArray().length,
        stores: state.storage.sql
          .exec("SELECT 1 FROM preview_stores WHERE chat_id = ?", chatId)
          .toArray().length,
      }));
    const before = await kept();
    const request = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.titles"
    );
    await chatsOf(builder).dropDraft(chatId, app, {
      runId: await openTestRun(chatsOf(builder), chatId),
    });
    await vi.waitFor(async () => {
      await expect(kept()).resolves.toStrictEqual({
        releases: 0,
        artifacts: 0,
        stores: 0,
      });
    });
    const dropped = await failure(
      async () => await chats.previewFunction(chatId, app, revision, request)
    );

    // A new draft's preview, then the chat goes.
    const next = await chatsOf(builder).saveDraft(
      chatId,
      app,
      1,
      {
        "operations/notes.ts": notesFiles("again")["operations/notes.ts"] ?? "",
      },
      [],
      revision + 1,
      await openTestRun(chatsOf(builder), chatId)
    );
    expect(next).toBeTruthy();
    await chats.previewFunction(
      chatId,
      app,
      revision + 2,
      await requestFor(
        builder,
        { chatId, app, revision: revision + 2 },
        "notes.create",
        { title: "kept" }
      )
    );
    const again = await kept();
    await chats.remove(chatId);
    await vi.waitFor(async () => {
      await expect(kept()).resolves.toStrictEqual({
        releases: 0,
        artifacts: 0,
        stores: 0,
      });
    });
    const gone = await failure(
      async () =>
        await chats.previewFunction(chatId, app, revision + 2, request)
    );

    expect({ before, dropped, again, gone }).toMatchObject({
      before: { releases: 1, stores: 1 },
      dropped: "app.no_draft",
      again: { releases: 1, stores: 1 },
      gone: "agent.chat_not_found",
    });
  });

  it("seals a revision once for calls made together, and counts each call against the person's requests", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const { chats } = builder.api;
    // A request of this revision names the next one's functions too: a
    // write of a comment changes no contract.
    const request = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.titles"
    );
    await chatsOf(builder).saveDraft(
      chatId,
      app,
      1,
      {
        "operations/notes.ts": notesFiles("third")["operations/notes.ts"] ?? "",
      },
      [],
      revision,
      await openTestRun(chatsOf(builder), chatId)
    );
    // The next revision isn't sealed yet: the calls arrive together, each
    // runs, and none drops the seal another started.
    const together = await Promise.all(
      Array.from({ length: 3 }, async () =>
        answerHashOf(
          await chats.previewFunction(chatId, app, revision + 1, request)
        )
      )
    );
    expect(new Set(together).size).toBe(1);
    expect(together[0]).toMatch(/^[0-9a-f]{64}$/u);

    // The bucket fills again with time, so the clock is stopped.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      const other = await signedInApi(idp, "builder");
      await builder.api.apps.members.add(app, {
        type: "person",
        id: other.userId,
        role: "builder",
      });
      const theirs = await chatWithDraft(other, app, {
        "operations/notes.ts":
          notesFiles("drafted")["operations/notes.ts"] ?? "",
      });
      const codes: string[] = [];
      for (let count = 0; count <= screenLimits.requests.burst; count += 1) {
        codes.push(
          // oxlint-disable-next-line no-await-in-loop -- one request after another
          await failure(
            async () =>
              await other.api.chats.previewFunction(
                theirs.chatId,
                app,
                theirs.revision,
                "{}"
              )
          )
        );
      }
      expect(codes.at(-1)).toBe("screen.rate_limited");
      expect(codes.slice(0, -1).every((code) => code === "ok")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets a leftover store core's database never recorded, and gets past ones whose discard keeps failing", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    // Twenty leftovers that can't be discarded (listed stores, as nothing
    // of a preview's ever is), first in the page; one whose core row was
    // never written; one recorded as it should be.
    const stuck = Array.from(
      { length: 20 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
    );
    const unrecorded = "ffffffff-0000-4000-8000-000000000001";
    const gone = crypto.randomUUID();
    const recorded = "ffffffff-0000-4000-8000-000000000002";
    await env.DB.batch([
      ...stuck.flatMap((id) => [
        env.DB.prepare(
          "INSERT INTO business_stores (id, owner_id, physical_namespace_role, created_at) VALUES (?, ?, 'data_store', ?)"
        ).bind(id, builder.userId, Date.now()),
        env.DB.prepare(
          "INSERT INTO preview_fixture_stores (store_id, app_id, created_at) VALUES (?, ?, ?)"
        ).bind(id, app, Date.now()),
      ]),
      env.DB.prepare(
        "INSERT INTO preview_fixture_stores (store_id, app_id, created_at) VALUES (?, ?, ?)"
      ).bind(recorded, app, Date.now()),
    ]);
    await runInDurableObject(chatsOf(builder), (_instance, state) => {
      for (const id of [...stuck, unrecorded, recorded]) {
        state.storage.sql.exec(
          "INSERT INTO preview_stores (store_id, chat_id, app_id, revision) VALUES (?, ?, ?, 0)",
          id,
          // A chat gone since: only the sweep of leftovers reaches them.
          gone,
          app
        );
      }
    });
    const left = async () =>
      await runInDurableObject(chatsOf(builder), (_instance, state) =>
        state.storage.sql
          .exec<{ store_id: string }>(
            "SELECT store_id FROM preview_stores WHERE revision = 0 ORDER BY store_id"
          )
          .toArray()
          .map((row) => row.store_id)
      );
    // Two previews start, each discarding a page of leftovers: the first
    // finds the twenty failing, the second gets past them.
    await requestFor(builder, { chatId, app, revision }, "notes.titles");
    await vi.waitFor(async () => {
      await expect(left()).resolves.toHaveLength(stuck.length + 2);
    });
    await scheduler.wait(500);
    const next = await write(
      {
        "operations/notes.ts": notesFiles("again")["operations/notes.ts"] ?? "",
      },
      revision
    );
    await requestFor(builder, { chatId, app, revision: next }, "notes.titles");
    await vi.waitFor(async () => {
      await expect(left()).resolves.toStrictEqual(stuck);
    });
    const core = await env.DB.prepare(
      "SELECT store_id FROM preview_fixture_stores WHERE store_id = ?"
    )
      .bind(recorded)
      .first();
    expect(core).toBeNull();
  });

  it("sets up again a store kept for its revision whose setup a failure cut short", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const request = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.create",
      { title: "after all" }
    );
    // Recorded in the chat's object, then cut short: no row in core's
    // database, no tables in its object.
    const id = crypto.randomUUID();
    await runInDurableObject(chatsOf(builder), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO preview_stores (store_id, chat_id, app_id, revision) VALUES (?, ?, ?, ?)",
        id,
        chatId,
        app,
        revision
      );
    });
    const created = outcome(
      await builder.api.chats.previewFunction(chatId, app, revision, request)
    );
    const core = await env.DB.prepare(
      "SELECT store_id FROM preview_fixture_stores WHERE store_id = ?"
    )
      .bind(id)
      .first();
    expect({ created: typeof created, core }).toStrictEqual({
      created: "string",
      core: { store_id: id },
    });
  });

  it("refuses a kept draft release whose manifest changed, or that binds a store", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const request = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.titles"
    );
    /** Rewrites the kept manifest with `change`, its hash too if `rehash`. */
    const tampered = async (
      change: (manifest: Record<string, unknown>) => Record<string, unknown>,
      rehash: boolean
    ): Promise<unknown> => {
      const kept = await runInDurableObject(
        chatsOf(builder),
        (_instance, state) =>
          state.storage.sql
            .exec<{ manifest: string; manifest_hash: string }>(
              "SELECT manifest, manifest_hash FROM preview_releases WHERE chat_id = ?",
              chatId
            )
            .toArray()
      );
      const [row] = kept;
      const parsed = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(row?.manifest ?? "null"));
      const text = canonicalText(change(parsed));
      const hash = rehash ? await sha256Hex(text) : (row?.manifest_hash ?? "");
      await runInDurableObject(chatsOf(builder), (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE preview_releases SET manifest = ?, manifest_hash = ? WHERE chat_id = ?",
          text,
          hash,
          chatId
        );
      });
      await runInDurableObject(chatsOf(builder), (_instance, state) => {
        state.abort("Restarted by the test");
      }).catch(() => {
        // Aborting fails the call that aborted: that is the restart.
      });
      const answer = outcome(
        await builder.api.chats.previewFunction(chatId, app, revision, request)
      );
      // Put back for the next case.
      await runInDurableObject(chatsOf(builder), (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE preview_releases SET manifest = ?, manifest_hash = ? WHERE chat_id = ?",
          row?.manifest ?? "",
          row?.manifest_hash ?? "",
          chatId
        );
      });
      await runInDurableObject(chatsOf(builder), (_instance, state) => {
        state.abort("Restarted by the test");
      }).catch(() => {
        // As above.
      });
      return answer;
    };
    const sha = "0".repeat(64);
    expect({
      // A manifest changed, still canonical and valid, under its old hash.
      changed: await tampered(
        (manifest) => ({ ...manifest, sdkVersion: "0.0.0-elsewhere" }),
        false
      ),
      // A manifest that binds a store, its hash made again to match.
      bound: await tampered(
        (manifest) => ({
          ...manifest,
          dataStoreBindings: [
            {
              alias: "default",
              storeId: crypto.randomUUID(),
              schemaVersion: 1,
              schemaHash: sha,
              operationManifestHash: sha,
            },
          ],
        }),
        true
      ),
      intact: outcome(
        await builder.api.chats.previewFunction(chatId, app, revision, request)
      ),
    }).toStrictEqual({
      changed: "version.manifest_corrupt",
      bound: "version.manifest_corrupt",
      intact: [],
    });
  });

  it("follows only a query live: a mutation's reference is refused, and runs nothing", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const { chats } = builder.api;
    const pushed: QuerySnapshotPush[] = [];
    await chats.previewWatchQuery(
      chatId,
      app,
      revision,
      await requestFor(builder, { chatId, app, revision }, "notes.create", {
        title: "written live",
      }),
      (snapshot) => {
        pushed.push(snapshot);
      }
    );
    await vi.waitFor(() => {
      expect(pushed.length).toBeGreaterThan(0);
    });
    const titles = outcome(
      await chats.previewFunction(
        chatId,
        app,
        revision,
        await requestFor(builder, { chatId, app, revision }, "notes.titles")
      )
    );
    expect({ first: outcome(pushed[0]), titles }).toStrictEqual({
      first: "contract.invalid_request",
      titles: [],
    });
  });

  it("keeps for the agent's check that its draft doesn't seal, as a call of the preview found it", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { chatId, revision } = await chatWithDraft(builder, app, {
      "operations/notes.ts": "export const titles = ;\n",
    });
    const request = JSON.stringify({
      reference: {
        resourceId: app,
        resourceVersion: 2,
        contractId: "notes.titles",
        fingerprint: "0".repeat(64),
        kind: "query",
      },
      input: {},
    });
    const called = outcome(
      await builder.api.chats.previewFunction(chatId, app, revision, request)
    );
    const { problems } = await chatsOf(builder).previewReports(
      chatId,
      app,
      revision,
      0
    );
    expect({
      called,
      problems: problems.map(({ source, at, message }) => ({
        source,
        at,
        sealing: message.startsWith("version.build_failed"),
      })),
    }).toStrictEqual({
      called: "version.build_failed",
      problems: [{ source: "server", at: "notes.titles", sealing: true }],
    });
  });

  it("reads a paginated list's window on the preview's store, then the larger window a Load More asks for", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const { chats } = builder.api;
    for (const title of ["one", "two", "three"]) {
      // oxlint-disable-next-line no-await-in-loop -- one note after the other
      const create = await requestFor(
        builder,
        { chatId, app, revision },
        "notes.create",
        { title }
      );
      // oxlint-disable-next-line no-await-in-loop -- see above
      await chats.previewFunction(chatId, app, revision, create);
    }
    const windowOf = async (extent: number): Promise<unknown> => {
      const request = z
        .record(z.string(), z.unknown())
        .parse(
          JSON.parse(
            await requestFor(builder, { chatId, app, revision }, "notes.list")
          )
        );
      const answer = outcome(
        await chats.previewFunction(
          chatId,
          app,
          revision,
          JSON.stringify({ ...request, window: { extent } })
        )
      );
      const read = z
        .object({
          items: z.array(z.object({ title: z.string() })),
          hasMore: z.boolean(),
        })
        .safeParse(answer);
      return read.success
        ? {
            titles: read.data.items.map((note) => note.title),
            hasMore: read.data.hasMore,
          }
        : answer;
    };
    expect({
      first: await windowOf(2),
      more: await windowOf(4),
    }).toStrictEqual({
      first: { titles: ["one", "two"], hasMore: true },
      more: { titles: ["one", "two", "three"], hasMore: false },
    });
  });
});
