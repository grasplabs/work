import { storeIdSchema } from "@grasp-os/shared/ids";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { holdThrowawayStore } from "../src/data-stores.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { appDefinition } from "./app-definitions.ts";
import { mockIdp } from "./idp.ts";
import {
  deskDraft,
  livePushes,
  notesFiles,
  preferenceCall,
  previewDraftsOf,
} from "./preview-drafts.ts";
import {
  chatsOf,
  outcome,
  previewCall,
  previewLease,
  previewStores,
  previewWatch,
  requestFor,
  storeEmptied,
} from "./previews.ts";
import { outcome as refusalOf, signedInApi } from "./sign-in.ts";
// A builder's preview of their draft (draft-runs.ts), from the page's
// side: the draft run through the normal runner on the path every page
// calls on, under the lease its preview opened with, on a throwaway store
// of its own with no resources, and what it fails with kept for the
// agent's check of the draft.

const idp = mockIdp();
const { setUp } = previewDraftsOf(idp);

describe("a draft's preview", { timeout: 180_000 }, () => {
  it("runs the draft's code on its own store, never the App's, and follows its live query", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const at = { chatId, app, revision };
    const live = livePushes();
    await previewWatch(
      builder,
      chatId,
      app,
      await requestFor(builder, at, "notes.titles"),
      live.push
    );
    const created = outcome(
      await previewCall(
        builder,
        chatId,
        app,
        await requestFor(builder, at, "notes.create", { title: "Draft" })
      )
    );
    await live.until((latest) => {
      expect(latest?.result).toStrictEqual({ ok: true, value: ["Draft"] });
    });
    // The App's own page reads the App's store, which the draft never
    // wrote to.
    const { lease } = await builder.api.pages.open(app);
    const real = outcome(
      await previewCall(
        builder,
        chatId,
        app,
        await requestFor(
          builder,
          { ...at, revision: { appVersion: 1 } },
          "notes.titles"
        ),
        lease
      )
    );
    expect({ created: typeof created, real }).toStrictEqual({
      created: "string",
      real: [],
    });
  });

  it("reaches no outside system, and keeps what the draft's code threw for the agent's check", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const at = { chatId, app, revision };
    const consulted = outcome(
      await previewCall(
        builder,
        chatId,
        app,
        await requestFor(builder, at, "notes.consult")
      )
    );
    const broken = outcome(
      await previewCall(
        builder,
        chatId,
        app,
        await requestFor(builder, at, "notes.broken")
      )
    );
    const reports = await chatsOf(builder).previewReports(
      chatId,
      app,
      revision,
      0
    );
    expect({
      consulted,
      broken,
      seen: reports.seen,
      problems: reports.problems.map(({ source, at: where }) => ({
        source,
        at: where,
      })),
    }).toStrictEqual({
      consulted: "resource.unavailable",
      broken: "internal.unexpected",
      seen: true,
      problems: [{ source: "server", at: "notes.broken" }],
    });
  });

  it("runs an action under its key once, as a release's page does", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const at = { chatId, app, revision };
    const keyed = JSON.stringify({
      ...JSON.parse(await requestFor(builder, at, "notes.forgiving")),
      idempotencyKey: crypto.randomUUID(),
    });
    const lease = await previewLease(builder, chatId, app);
    const [first, again] = [
      await previewCall(builder, chatId, app, keyed, lease),
      await previewCall(builder, chatId, app, keyed, lease),
    ];
    expect({ first: outcome(first), again: outcome(again) }).toStrictEqual({
      first: null,
      again: null,
    });
  });

  it("takes a write of its pages while its server code doesn't build, on the references it last built, its calls saying why", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    // Opened once its server code built: its references are kept.
    await previewLease(builder, chatId, app);
    const drafted = notesFiles("drafted");
    const broken = await write(
      {
        // Past what a query takes at once: it fails its type check.
        "server/notes.ts": (drafted["server/notes.ts"] ?? "").replace(
          'ctx.db.query("notes").take(100)).map',
          'ctx.db.query("notes").take(1000)).map'
        ),
        "src/routes/index.tsx": (drafted["src/routes/index.tsx"] ?? "").replace(
          '"Loading"',
          '"Waiting"'
        ),
      },
      revision
    );
    const update = await builder.api.chats.previewUpdate(
      chatId,
      app,
      broken,
      {}
    );
    const titles = outcome(
      await previewCall(
        builder,
        chatId,
        app,
        JSON.stringify({
          reference: { name: "notes.titles", kind: "query" },
          input: {},
        })
      )
    );
    expect({
      refreshed: "refresh" in update && update.refresh.revision,
      serverUnbuilt: "refresh" in update && update.refresh.serverUnbuilt,
      titles,
    }).toStrictEqual({
      refreshed: broken,
      serverUnbuilt: true,
      titles: "version.build_failed",
    });
  });

  it("answers the draft's preferences from its own store", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app, chatId } = await deskDraft(builder);
    const before = await preferenceCall(builder, { chatId, app }, "get", {});
    await preferenceCall(builder, { chatId, app }, "update", {
      expectedRevision: 0,
      patch: { theme: "dark" },
    });
    const after = await preferenceCall(builder, { chatId, app }, "get", {});
    expect({ before, after }).toStrictEqual({
      before: { _rev: 0, compact: false, theme: "light" },
      after: { _rev: 1, compact: false, theme: "dark" },
    });
  });

  it("starts a new store when the draft's schema changes", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const create = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.create",
      { title: "Before" }
    );
    await previewCall(builder, chatId, app, create);
    // The same App, with a table more.
    const next = await write(
      appDefinition({
        name: "Notes",
        tables: {
          notes: {
            fields: { title: "v.string().min(1).max(200)" },
            access: { read: "appMembers", write: "appMembers" },
          },
          tags: {
            fields: { name: "v.string()" },
            access: { read: "appMembers", write: "appMembers" },
          },
        },
        permissions: ["permission.ai({ maxOutputTokens: 100 })"],
      }),
      revision
    );
    const titles = outcome(
      await previewCall(
        builder,
        chatId,
        app,
        await requestFor(
          builder,
          { chatId, app, revision: next },
          "notes.titles"
        )
      )
    );
    expect(titles).toStrictEqual([]);
  });
});

/**
 * `setUp`'s preview with a note written to its throwaway store, and that
 * store's ID, as its chat keeps it.
 */
const withNote = async () => {
  const drafted = await setUp();
  const { builder, app, chatId, revision } = drafted;
  const at = { chatId, app, revision };
  await previewCall(
    builder,
    chatId,
    app,
    await requestFor(builder, at, "notes.create", { title: "Typed in" })
  );
  const [store] = await previewStores(builder, chatId, app);
  if (store === undefined) {
    throw new Error("The preview kept no store.");
  }
  const titles = async (): Promise<unknown> =>
    outcome(
      await previewCall(
        builder,
        chatId,
        app,
        await requestFor(builder, at, "notes.titles")
      )
    );
  return { ...drafted, storeId: store.store_id, titles };
};

describe("a draft preview's throwaway store", { timeout: 180_000 }, () => {
  it("is emptied for good at once when its chat is deleted", async () => {
    const { builder, chatId, storeId } = await withNote();
    await builder.api.chats.remove(chatId);
    await vi.waitFor(
      async () => {
        await expect(storeEmptied(storeId)).resolves.toBeTruthy();
      },
      { timeout: 10_000, interval: 100 }
    );
  });

  it("is emptied for good when its draft is discarded, and the next draft starts on an empty store", async () => {
    const { builder, app, chatId, write, storeId, titles } = await withNote();
    const before = await titles();
    await builder.api.chats.discardDraft(chatId, app);
    await vi.waitFor(
      async () => {
        await expect(storeEmptied(storeId)).resolves.toBeTruthy();
      },
      { timeout: 10_000, interval: 100 }
    );
    // A new draft with the same schema.
    const { revision } = await chatsOf(builder).previewDraft(
      chatId,
      builder.userId,
      app
    );
    await write(
      { "server/notes.ts": notesFiles("again")["server/notes.ts"] ?? "" },
      revision
    );
    expect({ before, after: await titles() }).toStrictEqual({
      before: ["Typed in"],
      after: [],
    });
  });

  it("is emptied for good when an admin removes its person", async () => {
    const { builder, storeId } = await withNote();
    const admin = await signedInApi(idp, "admin");
    await admin.api.members.remove(builder.userId);
    await expect(storeEmptied(storeId)).resolves.toBeTruthy();
  });

  it("is never held again once emptied, by a call that was already under way", async () => {
    const { builder, chatId, storeId } = await withNote();
    await builder.api.chats.remove(chatId);
    await vi.waitFor(
      async () => {
        await expect(storeEmptied(storeId)).resolves.toBeTruthy();
      },
      { timeout: 10_000, interval: 100 }
    );
    const held = await refusalOf(
      holdThrowawayStore(
        env,
        storeIdSchema.parse(storeId),
        Date.now() + 24 * 60 * 60 * 1000
      )
    );
    expect({ held, emptied: await storeEmptied(storeId) }).toStrictEqual({
      held: "data.fixture_discarded",
      emptied: true,
    });
  });

  it("empties itself a day after its last use, and its preview starts again on an empty store", async () => {
    const { storeId, titles } = await withNote();
    const before = await titles();
    const stub = inJurisdiction(env, env.DATA_STORES).getByName(storeId);
    // Its hold ran out.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.put("grasp_throwaway_until", Date.now() - 1);
      await state.storage.setAlarm(Date.now() - 1);
    });
    await runDurableObjectAlarm(stub).catch(() => {
      // The object ends itself once it emptied.
    });
    // Past the hour an isolate holds a store for before asking again.
    vi.useFakeTimers({
      toFake: ["Date"],
      now: Date.now() + 2 * 60 * 60 * 1000,
    });
    try {
      expect({
        before,
        after: await titles(),
        emptiedForGood: await storeEmptied(storeId),
      }).toStrictEqual({
        before: ["Typed in"],
        after: [],
        emptiedForGood: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
