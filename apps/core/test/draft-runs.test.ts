import { storeIdSchema } from "@grasp-os/shared/ids";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { holdThrowawayStore } from "../src/data-stores.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { testApp } from "./app-definitions.ts";
import { mockIdp } from "./idp.ts";
import { livePushes, notesFiles, previewDraftsOf } from "./preview-drafts.ts";
import {
  outcome,
  previewCall,
  previewLease,
  previewOf,
  previewStores,
  previewWatch,
  requestFor,
  storeEmptied,
} from "./previews.ts";
import { outcome as refusalOf, signedInApi } from "./sign-in.ts";
// An App's preview of its one shared draft (draft-runs.ts), from the
// page's side: the draft run through the normal runner on the path every
// page calls on, under the lease its preview opened with, as whoever
// calls, on one throwaway store of test data its builders share, with no
// resources, and what it fails with kept for the next check of the draft.

const idp = mockIdp();
const { setUp } = previewDraftsOf(idp);

describe("a draft's preview", { timeout: 180_000 }, () => {
  it("runs the draft's code on its own store, never the App's, and follows its live query", async () => {
    const { builder, app, revision } = await setUp();
    const at = { app, revision };
    const live = livePushes();
    await previewWatch(
      builder,
      app,
      await requestFor(at, "notes.titles"),
      live.push
    );
    const created = outcome(
      await previewCall(
        builder,
        app,
        await requestFor(at, "notes.create", { title: "Draft" })
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
        app,
        await requestFor(
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
    const { builder, app, revision } = await setUp();
    const at = { app, revision };
    const consulted = outcome(
      await previewCall(builder, app, await requestFor(at, "notes.consult"))
    );
    const broken = outcome(
      await previewCall(builder, app, await requestFor(at, "notes.broken"))
    );
    const reports = await previewOf(app).reports(revision, 0);
    expect({
      consulted,
      broken,
      seen: reports.seen,
      problems: reports.problems.map(({ source, at: where }) => ({
        source,
        at: where,
      })),
    }).toStrictEqual({
      consulted: "permission.unavailable",
      broken: "internal.unexpected",
      seen: true,
      problems: [{ source: "server", at: "notes.broken" }],
    });
  });

  it("runs an action under its key once, as a release's page does", async () => {
    const { builder, app, revision } = await setUp();
    const at = { app, revision };
    const keyed = JSON.stringify({
      ...JSON.parse(await requestFor(at, "notes.forgiving")),
      idempotencyKey: crypto.randomUUID(),
    });
    const lease = await previewLease(builder, app);
    const [first, again] = [
      await previewCall(builder, app, keyed, lease),
      await previewCall(builder, app, keyed, lease),
    ];
    expect({ first: outcome(first), again: outcome(again) }).toStrictEqual({
      first: null,
      again: null,
    });
  });

  it("takes a write of its pages while its server code doesn't build, on the references it last built, its calls saying why", async () => {
    const { builder, app, revision, write } = await setUp();
    // Opened once its server code built: its references are kept.
    await previewLease(builder, app);
    const drafted = notesFiles("drafted");
    const broken = await write(
      {
        // A count that isn't a number: it fails its type check.
        "server/notes.ts": (drafted.files["server/notes.ts"] ?? "").replace(
          'ctx.db.query("notes").take(100)).map',
          'ctx.db.query("notes").take("all")).map'
        ),
        "src/routes/index.tsx": (
          drafted.files["src/routes/index.tsx"] ?? ""
        ).replace('"Loading"', '"Waiting"'),
      },
      revision
    );
    const update = await builder.api.apps.drafts.previewUpdate(app, broken, {});
    const titles = outcome(
      await previewCall(
        builder,
        app,
        JSON.stringify({
          reference: { name: "notes.titles", kind: "query" },
          args: {},
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

  it("starts a new store when the draft's schema changes", async () => {
    const { builder, app, revision, write } = await setUp();
    const create = await requestFor({ app, revision }, "notes.create", {
      title: "Before",
    });
    await previewCall(builder, app, create);
    // The same App, with a table more.
    const next = await write(
      testApp({
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
        app,
        await requestFor({ app, revision: next }, "notes.titles")
      )
    );
    expect(titles).toStrictEqual([]);
  });
});

/**
 * `setUp`'s preview with a note written to its throwaway store, and that
 * store's ID, as the App's preview keeps it.
 */
const withNote = async () => {
  const drafted = await setUp();
  const { builder, app, revision } = drafted;
  const at = { app, revision };
  await previewCall(
    builder,
    app,
    await requestFor(at, "notes.create", { title: "Typed in" })
  );
  const [store] = await previewStores(app);
  if (store === undefined) {
    throw new Error("The preview kept no store.");
  }
  const titles = async (): Promise<unknown> =>
    outcome(
      await previewCall(builder, app, await requestFor(at, "notes.titles"))
    );
  return { ...drafted, storeId: store, titles };
};

describe("a draft preview's throwaway store", { timeout: 180_000 }, () => {
  it("is shared by every builder of the App, each calling as themselves", async () => {
    const { builder, app, revision, titles } = await withNote();
    const other = await signedInApi(idp, "builder");
    await builder.api.apps.members.add(app, {
      type: "person",
      id: other.userId,
      role: "builder",
    });
    const theirs = outcome(
      await previewCall(
        other,
        app,
        await requestFor({ app, revision }, "notes.titles")
      )
    );
    expect({ theirs, mine: await titles() }).toStrictEqual({
      theirs: ["Typed in"],
      mine: ["Typed in"],
    });
  });

  it("is emptied for good at once when a builder resets the test data, and the next call starts on an empty store", async () => {
    const { builder, app, storeId, titles } = await withNote();
    const before = await titles();
    await builder.api.apps.drafts.resetTestData(app);
    const emptied = await storeEmptied(storeId);
    expect({ before, emptied, after: await titles() }).toStrictEqual({
      before: ["Typed in"],
      emptied: true,
      after: [],
    });
  });

  it("keeps its test data when the draft is discarded, for the next draft over the same schema", async () => {
    const { builder, app, write, titles } = await withNote();
    const { revision } = await builder.api.apps.drafts.get(app);
    await builder.api.apps.drafts.discard(app, revision);
    await write(
      { "server/notes.ts": notesFiles("again").files["server/notes.ts"] ?? "" },
      revision + 1
    );
    await expect(titles()).resolves.toStrictEqual(["Typed in"]);
  });

  it("forgets a person an admin erased, and keeps everyone else", async () => {
    const { storeId } = await withNote();
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "builder");
    const other = await signedInApi(idp, "builder");
    const store = inJurisdiction(env, env.DATA_STORES).getByName(
      storeIdSchema.parse(storeId)
    );
    const preferencesOf = async (who: string): Promise<number> =>
      await runInDurableObject(
        store,
        (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM sdk_preferences WHERE person_id = ?",
              who
            )
            .one().count
      );
    await runInDurableObject(store, (_instance, state) => {
      for (const who of [person.userId, other.userId]) {
        state.storage.sql.exec(
          "INSERT INTO sdk_preferences (person_id, revision, value_json, updated_at) VALUES (?, 1, '{}', ?)",
          who,
          Date.now()
        );
      }
    });
    await admin.api.members.remove(person.userId);
    await admin.api.members.erase(person.userId, String(person.person.name));
    expect({
      theirs: await preferencesOf(person.userId),
      others: await preferencesOf(other.userId),
    }).toStrictEqual({ theirs: 0, others: 1 });
  });

  it("never makes again the store of a call that read the preview's seed before its test data was reset", async () => {
    const { builder, app } = await setUp();
    // A call under way read the seed, then the test data was reset.
    const { seed } = await previewOf(app).run();
    await builder.api.apps.drafts.resetTestData(app);
    const storeId = `throwaway-${crypto.randomUUID()}`;
    const kept = await refusalOf(previewOf(app).keepStore({ storeId, seed }));
    expect({ kept, recorded: await previewStores(app) }).toStrictEqual({
      kept: "app.preview_outdated",
      recorded: [],
    });
  });

  it("refuses the commit of a call still under way when its test data is reset, and the next call starts empty", async () => {
    const { builder, app, revision } = await setUp();
    const at = { app, revision };
    // Writes once a wait is over.
    const late = previewCall(builder, app, await requestFor(at, "notes.late"));
    await vi.waitFor(
      async () => {
        await expect(previewStores(app)).resolves.toHaveLength(1);
      },
      { timeout: 10_000, interval: 100 }
    );
    await builder.api.apps.drafts.resetTestData(app);
    const settled = outcome(await late);
    const titles = outcome(
      await previewCall(builder, app, await requestFor(at, "notes.titles"))
    );
    expect({ settled: typeof settled, titles }).toStrictEqual({
      // Refused, whatever the code: it wrote nothing anywhere.
      settled: "string",
      titles: [],
    });
  });

  it("is emptied for good when its App is removed", async () => {
    const { builder, app, storeId } = await withNote();
    await builder.api.apps.archive(app);
    await builder.api.apps.remove(app);
    await expect(storeEmptied(storeId)).resolves.toBeTruthy();
  });

  it("is never held again once emptied, by a call that was already under way", async () => {
    const { builder, app, storeId } = await withNote();
    await builder.api.apps.drafts.resetTestData(app);
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
