import { describe, expect, it } from "vite-plus/test";

import { appDefinition } from "./app-definitions.ts";
import { mockIdp } from "./idp.ts";
import {
  deskDraft,
  livePushes,
  preferenceCall,
  previewDraftsOf,
} from "./preview-drafts.ts";
import {
  chatsOf,
  outcome,
  previewCall,
  previewLease,
  previewWatch,
  requestFor,
} from "./previews.ts";
import { signedInApi } from "./sign-in.ts";

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

  it("answers the draft's preferences from its own store", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app, chatId } = await deskDraft(builder);
    const before = await preferenceCall(builder, { chatId, app }, "get", {});
    await preferenceCall(builder, { chatId, app }, "update", {
      theme: "dark",
    });
    const after = await preferenceCall(builder, { chatId, app }, "get", {});
    expect({ before, after }).toStrictEqual({
      before: { compact: false, theme: "light" },
      after: { compact: false, theme: "dark" },
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
