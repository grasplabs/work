import { storeIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import type { DataStore } from "../src/data-store.ts";
import { discardFixtureStore, openFixtureStore } from "../src/data-stores.ts";
import { sweepPreviewStores } from "../src/sealed-previews.ts";
import { openTestRun } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import {
  notesFiles,
  previewDraftsOf,
  retryOf,
  settled,
} from "./preview-drafts.ts";
import { chatsOf, outcome, previewStores, requestFor } from "./previews.ts";
import { failure } from "./sealed-apps.ts";

// A chat's preview of its draft of an App of spec 8's layout
// (sealed-previews.ts): the draft sealed into a draft release, and every
// call of its screens, its live queries and the chat's agent run on it
// through the operation host, on a store of the preview's own. These
// tests start from the ways it can fail (the threat model on GRA-652):
// the draft reads or writes the App's data, reaches an outside system,
// runs code that wasn't sealed or changed since, is taken for a version's
// release, is used by someone else or once its person no longer builds
// the App, outlives its draft or its use, or leaks one preview's data into
// another's.

const idp = mockIdp();
const { setUp } = previewDraftsOf(idp);

describe("previewing a draft of spec 8's layout", { timeout: 180_000 }, () => {
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

  it("starts a new store when the one kept for its revision isn't one core records: cut short before it was, or swept since", async () => {
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
    const stores = await previewStores(builder, chatId, app);
    const core = await env.DB.prepare(
      "SELECT store_id FROM preview_fixture_stores WHERE store_id = ?"
    )
      .bind(stores[0]?.store_id ?? "")
      .first();
    expect({
      created: typeof created,
      // One store for the revision, not the one cut short, recorded.
      stores: stores.length,
      renewed: stores[0]?.store_id !== id,
      core: core !== null,
    }).toStrictEqual({
      created: "string",
      stores: 1,
      renewed: true,
      core: true,
    });
  });

  it("is out of date once its store is swept, then starts a new, empty store, and nothing is written into the swept one", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const call = async (path: string, input: unknown = {}) =>
      outcome(
        await builder.api.chats.previewFunction(
          chatId,
          app,
          revision,
          await requestFor(builder, { chatId, app, revision }, path, input)
        )
      );
    await call("notes.create", { title: "typed in" });
    const [swept] = await previewStores(builder, chatId, app);
    const sweptId = swept?.store_id ?? "";
    // What the sweep does to it, while the preview still runs on it: its
    // object discarded first, then core's record.
    await discardFixtureStore(env, storeIdSchema.parse(sweptId));
    await env.DB.prepare(
      "DELETE FROM preview_fixture_stores WHERE store_id = ?"
    )
      .bind(sweptId)
      .run();
    // Calls made together: each is out of date, or answers on a new store
    // another made meanwhile; none runs on the swept one.
    const [outdated, together] = await Promise.all([
      call("notes.titles"),
      call("notes.titles"),
    ]);
    const fresh = await call("notes.titles");
    const created = typeof (await call("notes.create", { title: "again" }));
    const stores = await previewStores(builder, chatId, app);
    const sweptRefusal = await failure(
      async () =>
        await openFixtureStore(env, storeIdSchema.parse(sweptId)).get(
          "notes",
          "any"
        )
    );
    expect({
      outdated: settled(outdated),
      together: settled(together),
      someOutdated: [outdated, together].includes("app.preview_outdated"),
      fresh,
      created,
      // The preview forgot the swept store and keeps a new one.
      stores: stores.map(({ store_id: id }) => id === sweptId),
      // The swept store refuses everything: nothing is written into it.
      swept: sweptRefusal.includes("discarded"),
    }).toStrictEqual({
      outdated: "settled",
      together: "settled",
      someOutdated: true,
      fresh: [],
      created: "string",
      stores: [false],
      swept: true,
    });
  });

  it("is out of date when its store was discarded while core still records it, a call already writing included, then starts a new store", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const call = async (path: string, input: unknown = {}) =>
      await builder.api.chats.previewFunction(
        chatId,
        app,
        revision,
        await requestFor(builder, { chatId, app, revision }, path, input)
      );
    await call("notes.create", { title: "typed in" });
    const [first] = await previewStores(builder, chatId, app);
    const firstId = storeIdSchema.parse(first?.store_id);
    // A call under way, waiting to write, as the sweep discards its store's
    // object and hasn't deleted core's record yet.
    const writing = call("notes.late");
    await scheduler.wait(1000);
    await discardFixtureStore(env, firstId);
    const inFlight = outcome(await writing);
    const afterInFlight = outcome(await call("notes.titles"));
    // Again, with a call that starts once the store is discarded and still
    // recorded.
    const [second] = await previewStores(builder, chatId, app);
    const secondId = storeIdSchema.parse(second?.store_id);
    await discardFixtureStore(env, secondId);
    const recorded = outcome(await call("notes.titles"));
    const fresh = outcome(await call("notes.titles"));
    const [third] = await previewStores(builder, chatId, app);
    // A paginated window's read, whose last check of its reads finds the
    // store discarded: out of date too, and the store forgotten.
    await discardFixtureStore(env, storeIdSchema.parse(third?.store_id));
    const listRequest = z
      .record(z.string(), z.unknown())
      .parse(
        JSON.parse(
          await requestFor(builder, { chatId, app, revision }, "notes.list")
        )
      );
    const windowed = outcome(
      await builder.api.chats.previewFunction(
        chatId,
        app,
        revision,
        JSON.stringify({ ...listRequest, window: { extent: 2 } })
      )
    );
    const afterWindow = outcome(await call("notes.titles"));
    expect({
      inFlight,
      afterInFlight,
      renewed: secondId !== firstId,
      recorded,
      fresh,
      renewedAgain: third?.store_id !== secondId,
      windowed,
      afterWindow,
    }).toStrictEqual({
      inFlight: "app.preview_outdated",
      afterInFlight: [],
      renewed: true,
      recorded: "app.preview_outdated",
      fresh: [],
      renewedAgain: true,
      windowed: "app.preview_outdated",
      afterWindow: [],
    });
  });

  it("gets past a store whose discard hangs, and leaves it until its retry delay is over", async () => {
    const { app } = await setUp();
    const weekAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const hung = crypto.randomUUID();
    const next = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO preview_fixture_stores (store_id, app_id, created_at) VALUES (?, ?, ?)"
      ).bind(hung, app, weekAgo - 1000),
      env.DB.prepare(
        "INSERT INTO preview_fixture_stores (store_id, app_id, created_at) VALUES (?, ?, ?)"
      ).bind(next, app, weekAgo),
    ]);
    // The oldest store's object never answers its discard, as one whose
    // storage hangs.
    let tries = 0;
    const namespace = (
      real: DurableObjectNamespace<DataStore>
    ): DurableObjectNamespace<DataStore> =>
      new Proxy(real, {
        get: (target, property): unknown => {
          if (property === "jurisdiction") {
            return (jurisdiction: DurableObjectJurisdiction) =>
              namespace(target.jurisdiction(jurisdiction));
          }
          if (property === "getByName") {
            return (name: string) => {
              if (name !== hung) {
                return target.getByName(name);
              }
              return {
                discardFixture: async () => {
                  tries += 1;
                  // Never answers.
                  await Promise.withResolvers<undefined>().promise;
                },
              };
            };
          }
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const hanging = { ...env, DATA_STORES: namespace(env.DATA_STORES) };
    const now = new Date();
    await sweepPreviewStores(hanging, now);
    const first = { hung: await retryOf(hung), next: await retryOf(next) };
    // Again within its delay: the hung store isn't tried.
    await sweepPreviewStores(hanging, now);
    const triesWithin = tries;
    // Once its delay is over, it is.
    await sweepPreviewStores(
      hanging,
      new Date(now.getTime() + 2 * 60 * 60 * 1000)
    );
    expect({
      // The later store was discarded and forgotten in the same sweep.
      next: first.next,
      hungDelayed: (first.hung?.retryAfter ?? 0) > now.getTime(),
      triesWithin,
      triesAfter: tries,
    }).toStrictEqual({
      next: null,
      hungDelayed: true,
      triesWithin: 1,
      triesAfter: 2,
    });
  });

  it("sweeps preview stores a week old, oldest first, batch after batch, each discarded before its record goes", async () => {
    const { builder, app } = await setUp();
    const weekAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    // More old stores than one batch takes, one recent, and before them a
    // whole batch of stores recorded as a preview's that the inventory
    // lists: never discarded, and never holding up the rest.
    const old = Array.from({ length: 101 }, () => crypto.randomUUID());
    const recent = crypto.randomUUID();
    const stuck = Array.from({ length: 100 }, () => crypto.randomUUID());
    const [listed = ""] = stuck;
    await env.DB.batch([
      ...stuck.flatMap((id) => [
        env.DB.prepare(
          "INSERT INTO business_stores (id, owner_id, physical_namespace_role, created_at) VALUES (?, ?, 'data_store', ?)"
        ).bind(id, builder.userId, Date.now()),
        env.DB.prepare(
          "INSERT INTO preview_fixture_stores (store_id, app_id, created_at) VALUES (?, ?, ?)"
        ).bind(id, app, weekAgo - 1000),
      ]),
      ...old.map((id, index) =>
        env.DB.prepare(
          "INSERT INTO preview_fixture_stores (store_id, app_id, created_at) VALUES (?, ?, ?)"
        ).bind(id, app, weekAgo + index)
      ),
      env.DB.prepare(
        "INSERT INTO preview_fixture_stores (store_id, app_id, created_at) VALUES (?, ?, ?)"
      ).bind(recent, app, Date.now()),
    ]);
    await sweepPreviewStores(env);
    const { results } = await env.DB.prepare(
      "SELECT store_id FROM preview_fixture_stores WHERE app_id = ?"
    )
      .bind(app)
      .all<{ store_id: string }>();
    const kept = new Set(results.map((row) => row.store_id));
    const refusals = await Promise.all(
      [old[0], old[100]].map(
        async (id) =>
          await failure(
            async () =>
              await openFixtureStore(env, storeIdSchema.parse(id)).get(
                "notes",
                "any"
              )
          )
      )
    );
    expect({
      oldKept: old.filter((id) => kept.has(id)).length,
      recent: kept.has(recent),
      // Their discard refused, so their records stay for the next sweep.
      listed: kept.has(listed) && stuck.every((id) => kept.has(id)),
      discarded: refusals.map((code) => code.includes("discarded")),
    }).toStrictEqual({
      oldKept: 0,
      recent: true,
      listed: true,
      discarded: [true, true],
    });
  });
});
