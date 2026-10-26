import { appIdSchema, storeIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { discardFixtureStore } from "../src/data-stores.ts";
import { appMembers } from "../src/db/core/schema.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  deskDraft,
  deskFiles,
  draftVersion,
  livePushes,
  notesFiles,
  preferenceCall,
  preferenceReference,
  withPreferences,
} from "./preview-drafts.ts";
import {
  chatsOf,
  chatWithDraft,
  keptManifestSchema,
  outcome,
  outcomeOfText,
  previewStores,
  requestFor,
} from "./previews.ts";
import { failure } from "./sealed-apps.ts";
import { signedInApi } from "./sign-in.ts";

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

describe("previewing a draft of spec 8's layout", { timeout: 180_000 }, () => {
  it("answers the draft's preferences from its own store, never its person's real ones, and refuses workflow-reference queries", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Notes" });
    await release(builder, id, withPreferences(notesFiles("released")));
    const app = appIdSchema.parse(id);
    const asBuilder = {
      userId: builder.userId,
      role: "builder" as const,
      teams: [],
    };
    // Their real preferences, on the App's current version.
    const live = async (name: "get" | "update", input: unknown) => {
      const answered = await callAppFunction(
        env,
        asBuilder,
        app,
        JSON.stringify({
          reference: await preferenceReference(app, 1, name),
          input,
        })
      );
      return answered.result.ok
        ? answered.result.value
        : answered.result.error.code;
    };
    await live("update", { expectedRevision: 0, patch: { compact: true } });
    const { chatId, revision, write } = await chatWithDraft(
      builder,
      app,
      withPreferences(notesFiles("drafted"))
    );
    /** A call of the draft at `at`, of `reference`, with `input`. */
    const previewed = async (at: number, reference: unknown, input: unknown) =>
      outcome(
        await builder.api.chats.previewFunction(
          chatId,
          app,
          at,
          JSON.stringify({ reference, input })
        )
      );
    /** The draft release's version at `at`, from a call of its own. */
    const versionAt = async (at: number): Promise<number> =>
      z
        .object({ reference: z.object({ resourceVersion: z.int() }) })
        .parse(
          JSON.parse(
            await requestFor(
              builder,
              { chatId, app, revision: at },
              "notes.titles"
            )
          )
        ).reference.resourceVersion;
    const versionNow = await versionAt(revision);
    const draft = {
      get: await preferenceReference(app, versionNow, "get"),
      update: await preferenceReference(app, versionNow, "update"),
    };
    const first = {
      // The defaults, not what they chose on the App.
      read: await previewed(revision, draft.get, {}),
      written: await previewed(revision, draft.update, {
        expectedRevision: 0,
        patch: { theme: "dark" },
      }),
      // A version's reference names nothing in the preview.
      versionsReference: await previewed(
        revision,
        await preferenceReference(app, 1, "get"),
        {}
      ),
      runs: await previewed(
        revision,
        {
          ...draft.get,
          contractId: "workflows.followUp.queries.runs",
        },
        { pagination: {} }
      ),
    };
    // Their real preferences are as they were.
    const real = await live("get", {});
    // A new revision starts on a new, empty store.
    const next = await write(
      {
        "operations/notes.ts": notesFiles("again")["operations/notes.ts"] ?? "",
      },
      revision
    );
    const nextVersion = await versionAt(next);
    const again = await previewed(
      next,
      await preferenceReference(app, nextVersion, "get"),
      {}
    );

    expect({ first, real, again }).toStrictEqual({
      first: {
        read: { compact: false, theme: "light", _rev: 0 },
        written: { compact: false, theme: "dark", _rev: 1 },
        versionsReference: "version.mismatch",
        runs: "resource.unavailable",
      },
      real: { compact: true, theme: "light", _rev: 1 },
      again: { compact: false, theme: "light", _rev: 0 },
    });
  });

  it("gives a draft with preferences and no tables a store of its own for them", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Desk" });
    await release(builder, id, deskFiles());
    const app = appIdSchema.parse(id);
    const { chatId, revision } = await chatWithDraft(builder, app, {
      "screens/desk.tsx": `export default function Desk() {
  return <main>Drafted desk</main>;
}
`,
    });
    // The draft release's version: the one its contracts were sealed for.
    await chatsOf(builder).previewReferences(
      chatId,
      builder.userId,
      app,
      revision
    );
    const version = await runInDurableObject(
      chatsOf(builder),
      (_instance, state) =>
        keptManifestSchema.parse(
          JSON.parse(
            state.storage.sql
              .exec<{ manifest: string }>(
                "SELECT manifest FROM preview_releases WHERE chat_id = ? AND app_id = ?",
                chatId,
                app
              )
              .one().manifest
          )
        ).resourceVersion
    );
    const answered = outcome(
      await builder.api.chats.previewFunction(
        chatId,
        app,
        revision,
        JSON.stringify({
          reference: await preferenceReference(app, version, "update"),
          input: { expectedRevision: 0, patch: { compact: true } },
        })
      )
    );
    // No longer an active member: the preview's own gate refuses, even
    // past the chat's checks (straight to the chat's object).
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(builder.userId)
      .run();
    const inactive = outcomeOfText(
      await chatsOf(builder).previewFunction(
        chatId,
        builder.userId,
        app,
        revision,
        JSON.stringify({
          reference: await preferenceReference(app, version, "get"),
          input: {},
        })
      )
    );
    expect({ answered, inactive }).toStrictEqual({
      answered: { compact: true, theme: "light", _rev: 1 },
      inactive: "permission.person_inactive",
    });
  });

  it("is out of date once its preference-only store is swept, then answers on a fresh store from the defaults", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Desk" });
    await release(builder, id, deskFiles());
    const app = appIdSchema.parse(id);
    const { chatId, revision } = await chatWithDraft(builder, app, {
      "screens/desk.tsx": `export default function Desk() {
  return <main>Drafted desk</main>;
}
`,
    });
    const at = { chatId, app, revision };
    const saved = await preferenceCall(builder, at, "update", {
      expectedRevision: 0,
      patch: { compact: true },
    });
    const [store] = await previewStores(builder, chatId, app);
    const sweptId = storeIdSchema.parse(store?.store_id);
    // What the sweep does to it, while the preview still runs on it.
    await discardFixtureStore(env, sweptId);
    await env.DB.prepare(
      "DELETE FROM preview_fixture_stores WHERE store_id = ?"
    )
      .bind(sweptId)
      .run();
    const outdated = await preferenceCall(builder, at, "get", {});
    const fresh = await preferenceCall(builder, at, "get", {});
    // And with the store discarded while core still records it.
    const [renewed] = await previewStores(builder, chatId, app);
    await discardFixtureStore(env, storeIdSchema.parse(renewed?.store_id));
    const recordedOutdated = await preferenceCall(builder, at, "get", {});
    const freshAgain = await preferenceCall(builder, at, "get", {});
    const [last] = await previewStores(builder, chatId, app);
    expect({
      saved,
      outdated,
      fresh,
      renewed: renewed?.store_id !== sweptId,
      recordedOutdated,
      freshAgain,
      renewedAgain: last?.store_id !== renewed?.store_id,
    }).toStrictEqual({
      saved: { compact: true, theme: "light", _rev: 1 },
      outdated: "app.preview_outdated",
      fresh: { compact: false, theme: "light", _rev: 0 },
      renewed: true,
      recordedOutdated: "app.preview_outdated",
      freshAgain: { compact: false, theme: "light", _rev: 0 },
      renewedAgain: true,
    });
  });
});

describe("a draft's preferences in its preview", { timeout: 180_000 }, () => {
  it("refuses a builder who lost the role while still a member, before any store is made for them", async () => {
    const owner = await signedInApi(idp, "builder");
    const { id } = await owner.api.apps.create({ name: "Notes" });
    await release(owner, id, withPreferences(notesFiles("released")));
    const app = appIdSchema.parse(id);
    const builder = await signedInApi(idp, "builder");
    await drizzle(env.DB).insert(appMembers).values({
      appId: app,
      memberType: "person",
      memberId: builder.userId,
      role: "builder",
      addedBy: owner.userId,
      addedAt: new Date(),
    });
    const { chatId, revision } = await chatWithDraft(
      builder,
      app,
      withPreferences(notesFiles("drafted"))
    );
    const titles = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.titles"
    );
    // Still a member of the App, as one of its users only.
    await drizzle(env.DB)
      .update(appMembers)
      .set({ role: "user" })
      .where(
        and(eq(appMembers.appId, app), eq(appMembers.memberId, builder.userId))
      );
    const refused = {
      preferences: await preferenceCall(
        builder,
        { chatId, app, revision },
        "get",
        {}
      ),
      functions: outcomeOfText(
        await chatsOf(builder).previewFunction(
          chatId,
          builder.userId,
          app,
          revision,
          titles
        )
      ),
    };
    expect({
      refused,
      stores: await previewStores(builder, chatId, app),
    }).toStrictEqual({
      refused: { preferences: "role.forbidden", functions: "role.forbidden" },
      stores: [],
    });
  });

  it("refuses a call past its deadline, reading and writing nothing", async () => {
    const builder = await signedInApi(idp, "builder");
    const draft = await deskDraft(builder);
    const late = await preferenceCall(
      builder,
      draft,
      "update",
      { expectedRevision: 0, patch: { compact: true } },
      { deadline: Date.now() - 1 }
    );
    expect({
      late,
      read: await preferenceCall(builder, draft, "get", {}),
    }).toStrictEqual({
      late: "operation.deadline_exceeded",
      read: { compact: false, theme: "light", _rev: 0 },
    });
  });

  it("keeps each chat's preferences to itself, and drops them with its preview", async () => {
    const builder = await signedInApi(idp, "builder");
    const first = await deskDraft(builder);
    const second = await chatWithDraft(builder, first.app, {
      "screens/desk.tsx": deskFiles("Elsewhere")["screens/desk.tsx"] ?? "",
    });
    const secondAt = { ...second, app: first.app };
    await preferenceCall(builder, first, "update", {
      expectedRevision: 0,
      patch: { theme: "dark" },
    });
    // Another chat's preview of the same App has its own.
    const elsewhere = await preferenceCall(builder, secondAt, "get", {});
    // The draft changes: its preview, and the store holding its
    // preferences, go; the next revision starts from the defaults.
    const next = await first.write(
      { "screens/desk.tsx": deskFiles("Again")["screens/desk.tsx"] ?? "" },
      first.revision
    );
    const outdated = await failure(
      async () => await preferenceCall(builder, first, "get", {})
    );
    const again = await preferenceCall(
      builder,
      { ...first, revision: next },
      "get",
      {}
    );
    // The store of the revision before, with the preferences written
    // there, is discarded and forgotten.
    await vi.waitFor(async () => {
      const stores = await previewStores(builder, first.chatId, first.app);
      expect(stores.map((row) => row.revision)).toStrictEqual([next]);
    });
    expect({ elsewhere, outdated, again }).toStrictEqual({
      elsewhere: { compact: false, theme: "light", _rev: 0 },
      outdated: "app.preview_outdated",
      again: { compact: false, theme: "light", _rev: 0 },
    });
  });

  it("follows the draft's preferences live, pushed as they change", async () => {
    const builder = await signedInApi(idp, "builder");
    const draft = await deskDraft(builder);
    const live = livePushes();
    await builder.api.chats.previewWatchQuery(
      draft.chatId,
      draft.app,
      draft.revision,
      JSON.stringify({
        reference: await preferenceReference(
          draft.app,
          await draftVersion(builder, draft.chatId, draft.app, draft.revision),
          "get"
        ),
        input: {},
      }),
      live.push
    );
    await live.until((latest) => {
      expect(latest?.result).toStrictEqual({
        ok: true,
        value: { compact: false, theme: "light", _rev: 0 },
      });
    });
    await preferenceCall(builder, draft, "update", {
      expectedRevision: 0,
      patch: { compact: true },
    });
    await live.until((latest) => {
      expect(latest?.result).toStrictEqual({
        ok: true,
        value: { compact: true, theme: "light", _rev: 1 },
      });
    });
  });

  it("refuses a window of preferences before anything is charged", async () => {
    const builder = await signedInApi(idp, "builder");
    const draft = await deskDraft(builder);
    const request = JSON.stringify({
      reference: await preferenceReference(
        draft.app,
        await draftVersion(builder, draft.chatId, draft.app, draft.revision),
        "get"
      ),
      input: {},
      window: { extent: 500 },
    });
    await expect(
      failure(
        async () =>
          await builder.api.chats.previewFunction(
            draft.chatId,
            draft.app,
            draft.revision,
            request
          )
      )
    ).resolves.toBe("contract.invalid_request");
  });
});
