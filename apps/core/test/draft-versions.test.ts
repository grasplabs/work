import { readOnlyRevision, shownAt } from "@grasp-os/shared/chat";
import type { ChatDraft } from "@grasp-os/shared/chat";
import { appIdSchema, chatIdSchema } from "@grasp-os/shared/ids";
import type { AppId, ChatId } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import { openTestRun, testRunOpening } from "./agent-chat.ts";
import { testApp } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { loadFrame, modulePartsOf } from "./page-frames.ts";
import type { Framed } from "./page-frames.ts";
import {
  chatsOf,
  chatWithDraft,
  outcome,
  previewCall,
  requestFor,
} from "./previews.ts";
import { failure } from "./sealed-apps.ts";
import { signedInApi } from "./sign-in.ts";

// Each agent turn's writes of a chat's draft of an App are kept as one
// version, as the turn left the draft: listed, previewed read-only and
// restored as a new version, the draft discarded,
// only by the chat's person while they build the App, and gone with the
// chat. The version of the App a draft is proposed as is previewed
// read-only the same way, until it is published. These tests start from
// the ways it can fail: a write lost or kept out of order when writes
// land together, a turn's writes split into versions or one turn's
// folded into another's, a turn that wrote nothing or was cut short
// leaving a version that isn't the draft, a restore that rewrites history, an earlier or proposed
// version's preview that runs or changes anything, someone else (or a
// person who no longer builds the App) reading another's versions, and
// versions that outlive their chat.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/**
 * The code a preview's frame runs: each module's content address. Not its
 * frame's artifact, which a version opened read-only has of its own
 * (page-frame.ts, `previewFrame`), whatever code it runs.
 */
const codeOf = async (framed: Framed): Promise<string> => {
  const frame = await loadFrame(framed);
  return JSON.stringify(
    Object.values(frame?.addresses ?? {})
      .map((address) => modulePartsOf(address).hash)
      .toSorted()
  );
};

/** The Desk page, saying `marker`. */
const desk = (
  marker: string
): string => `import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@grasp-os/sdk/react";
import { api } from "@server/_generated/api";

const Desk = () => {
  const titles = useQuery(api.notes.titles, {});
  return <main>${marker}: {titles?.join(", ")}</main>;
};

export const Route = createFileRoute("/")({ component: Desk });
`;

/** An App of spec 8's layout whose one page says `marker` and reads its notes. */
const deskFiles = (marker: string): TestApp =>
  testApp(
    {
      name: "Desk",
      tables: {
        notes: {
          fields: { title: "v.string().min(1).max(200)" },
          access: { read: "appMembers", write: "appMembers" },
        },
      },
    },
    {
      "server/notes.ts": `import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";

export const titles = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const notes = await ctx.db.query("notes").take(100);
    return notes.map((note) => note.title);
  },
});
`,
      "src/routes/index.tsx": desk(marker),
    }
  );

/** What each of the chat's drafts changes, and at which revision. */
const changesOf = (drafts: readonly ChatDraft[]) =>
  drafts.map(({ changed, revision }) => ({ changed, revision }));

/** A Desk App of `builder`'s, released, and a chat with two writes of its draft. */
const twoVersions = async (builder: Person) => {
  const { id } = await builder.api.apps.create({ name: "Desk" });
  await release(builder, id, deskFiles("Released"));
  const app = appIdSchema.parse(id);
  const draft = await chatWithDraft(builder, app, {
    "src/routes/index.tsx": desk("One"),
  });
  const revision = await draft.write(
    { "src/routes/index.tsx": desk("Two") },
    draft.revision
  );
  return { app, chatId: draft.chatId, write: draft.write, revision };
};

/** Rows of the chat's draft versions, their files and contents left. */
const keptRows = async (person: Person, chatId: ChatId) =>
  await runInDurableObject(chatsOf(person), (_instance, state) =>
    Object.fromEntries(
      [
        "chat_draft_versions",
        "chat_draft_version_files",
        "chat_draft_contents",
      ].map((table) => [
        table,
        state.storage.sql
          .exec<{
            n: number;
          }>(`SELECT count(*) AS n FROM ${table} WHERE chat_id = ?`, chatId)
          .one().n,
      ])
    )
  );

describe("versions of a chat's draft", { timeout: 180_000 }, () => {
  it("keeps one version per agent turn that wrote, as the turn left the draft, whether or not it ended", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Desk" });
    await release(builder, id, deskFiles("Released"));
    const app = appIdSchema.parse(id);
    const { chats } = builder.api;
    const chat = await chats.create("Build");
    const chatId = chatIdSchema.parse(chat.id);
    const stub = chatsOf(builder);
    let revision = 0;
    /** Writes `changes` in a code run of turn `turnId`, as its code does. */
    const write = async (
      turnId: string,
      changes: Record<string, string>
    ): Promise<void> => {
      const run = await openTestRun(stub, chatId, turnId);
      if (
        !(await stub.saveDraft(chatId, app, 1, changes, [], revision, {
          runId: run,
        }))
      ) {
        throw new Error("The draft wasn't written");
      }
      revision += 1;
    };
    const numbers = async () => {
      const versions = await chats.draftVersions(chatId, app);
      return versions.map(({ number }) => number);
    };

    // One turn, three writes in as many code steps: one version, the last.
    await write("turn-1", { "src/routes/index.tsx": desk("One") });
    await write("turn-1", { "src/routes/index.tsx": desk("Two") });
    await write("turn-1", { "src/routes/notes.tsx": desk("Notes") });
    const [first] = await chats.draftVersions(chatId, app);
    const firstPreview = await chats.preview(chatId, app);
    const firstVersionPreview = await chats.preview(chatId, app, 1);
    const afterFirst = await keptRows(builder, chatId);
    // A turn that runs code but writes nothing keeps nothing.
    await openTestRun(stub, chatId, "turn-2");
    const afterNothing = await numbers();
    // A turn cut short after one write: what it wrote is its version, as
    // the draft holds it, and the next turn's is the next.
    await write("turn-3", { "src/routes/index.tsx": desk("Cut") });
    await write("turn-4", { "src/routes/index.tsx": desk("Four") });
    const [, cut] = await chats.draftVersions(chatId, app);
    // A restore while a turn writes: its next write is a version of its
    // own, after the restore, and the earlier versions stay as they were.
    await write("turn-5", { "src/routes/index.tsx": desk("Five") });
    await chats.restoreDraftVersion(chatId, app, 1);
    revision += 1;
    const restoredPreview = await chats.preview(chatId, app);
    await write("turn-5", { "src/routes/index.tsx": desk("Six") });
    const versions = await chats.draftVersions(chatId, app);
    const [draft] = await chats.drafts(chatId);
    // A discard while a turn writes: what it wrote before stays a version
    // to restore, and its next write is a version of its own.
    await write("turn-6", { "src/routes/index.tsx": desk("Seven") });
    const sevenPreview = await chats.preview(chatId, app);
    await chats.discardDraft(chatId, app);
    revision += 1;
    await write("turn-6", { "src/routes/index.tsx": desk("Eight") });
    // A turn that writes what an earlier version holds, then writes over
    // it: the earlier version still reads it.
    await write("turn-7", { "src/routes/index.tsx": desk("Two") });
    await write("turn-7", { "src/routes/index.tsx": desk("Nine") });
    const afterDiscard = await numbers();
    const sevenVersionPreview = await chats.preview(chatId, app, 7);
    const firstPreviewAfter = await chats.preview(chatId, app, 1);
    await chats.restoreDraftVersion(chatId, app, 7);
    const restoredSeven = await chats.preview(chatId, app);

    expect({
      first: {
        number: first?.number,
        revision: first?.revision,
        byAgent: first?.callId === testRunOpening.toolCallId,
        previewIsDraft:
          (await codeOf(firstVersionPreview)) === (await codeOf(firstPreview)),
      },
      // What the turn wrote over is no undo point: its two files, kept.
      afterFirst,
      afterNothing,
      cutIsDraft: cut?.revision === 4,
      numbers: versions.map(({ number }) => number),
      restoredFrom: versions.map(({ restoredFrom }) => restoredFrom),
      restoredIsFirst:
        (await codeOf(restoredPreview)) === (await codeOf(firstPreview)),
      kept: versions.at(-1),
      draftAtNewest: draft?.revision === versions[0]?.revision,
      afterDiscard,
      discardedKept:
        (await codeOf(sevenVersionPreview)) === (await codeOf(sevenPreview)),
      restoredSeven:
        (await codeOf(restoredSeven)) === (await codeOf(sevenPreview)),
      earlierHeld:
        (await codeOf(firstPreviewAfter)) === (await codeOf(firstPreview)),
    }).toStrictEqual({
      first: { number: 1, revision: 3, byAgent: true, previewIsDraft: true },
      afterFirst: {
        chat_draft_versions: 1,
        chat_draft_version_files: 2,
        chat_draft_contents: 2,
      },
      afterNothing: [1],
      cutIsDraft: true,
      numbers: [6, 5, 4, 3, 2, 1],
      restoredFrom: [null, 1, null, null, null, null],
      restoredIsFirst: true,
      kept: first,
      draftAtNewest: true,
      afterDiscard: [9, 8, 7, 6, 5, 4, 3, 2, 1],
      discardedKept: true,
      restoredSeven: true,
      earlierHeld: true,
    });
  });

  it("keeps each write of a run with no turn, as an earlier release opens one, as a version of its own", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Desk" });
    await release(builder, id, deskFiles("Released"));
    const app = appIdSchema.parse(id);
    const chat = await builder.api.chats.create("Build");
    const chatId = chatIdSchema.parse(chat.id);
    const stub = chatsOf(builder);
    for (const [at, marker] of ["One", "Two"].entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one write after the other
      const run = await openTestRun(stub, chatId, "turn-1");
      // oxlint-disable-next-line no-await-in-loop -- as above
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE chat_code_runs SET turn_id = NULL WHERE id = ?",
          run
        );
      });
      // oxlint-disable-next-line no-await-in-loop -- as above
      await stub.saveDraft(
        chatId,
        app,
        1,
        { "src/routes/index.tsx": desk(marker) },
        [],
        at,
        { runId: run }
      );
    }
    const versions = await builder.api.chats.draftVersions(chatId, app);

    expect(versions.map(({ number }) => number)).toStrictEqual([2, 1]);
  });

  it("keeps every write that lands together, numbered in the order they landed, and restores as a new version", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app, chatId, write, revision } = await twoVersions(builder);
    const { chats } = builder.api;
    const [two, one] = await chats.draftVersions(chatId, app);

    // Three restores and a write of the agent's, all at once: the write
    // lands only over the revision it read, the restores over whatever
    // the draft is by then.
    const [restored, wrote] = await Promise.all([
      Promise.all([
        chats.restoreDraftVersion(chatId, app, 1),
        chats.restoreDraftVersion(chatId, app, 2),
        chats.restoreDraftVersion(chatId, app, 1),
      ]),
      failure(
        async () =>
          await write({ "src/routes/index.tsx": desk("Three") }, revision)
      ),
    ]);
    const versions = await chats.draftVersions(chatId, app);
    const [newest] = versions;
    const [draft] = await chats.drafts(chatId);
    const landed = wrote === "ok" ? 1 : 0;

    expect({
      first: { number: one?.number, restoredFrom: one?.restoredFrom },
      wrote: typeof one?.callId === "string",
      differ: one?.contentHash !== two?.contentHash,
      count: versions.length,
      numbers: versions.map(({ number }) => number),
      revisions: versions
        .map(({ revision: made }) => made)
        .toSorted((a, b) => b - a),
      restored: restored
        .map(({ restoredFrom }) => restoredFrom)
        .toSorted((a, b) => (a ?? 0) - (b ?? 0)),
      sameContent: restored.every(
        ({ restoredFrom, contentHash }) =>
          contentHash ===
          (restoredFrom === 1 ? one?.contentHash : two?.contentHash)
      ),
      byPerson: restored.every(({ callId }) => callId === null),
      draftAtNewest: draft?.revision === newest?.revision,
      // The first two versions are as they were.
      kept: versions.slice(-2),
    }).toStrictEqual({
      first: { number: 1, restoredFrom: null },
      wrote: true,
      differ: true,
      count: 5 + landed,
      numbers: Array.from({ length: 5 + landed }, (_, at) => 5 + landed - at),
      revisions: versions.map(({ revision: made }) => made),
      restored: [1, 1, 2],
      sameContent: true,
      byPerson: true,
      draftAtNewest: true,
      kept: [two, one],
    });
  });

  it("previews an earlier version as it was, read-only, and the draft once it is restored", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app, chatId } = await twoVersions(builder);
    const { chats } = builder.api;

    const now = await chats.preview(chatId, app);
    const first = await chats.preview(chatId, app, 1);
    const second = await chats.preview(chatId, app, 2);
    // A version's page, the latest's (the draft as it is now) too, gets
    // no lease: nothing a version opened read-only calls runs.
    const calls = [first.lease, second.lease];
    await chats.restoreDraftVersion(chatId, app, 1);
    const restored = await chats.preview(chatId, app);

    const [nowCode, firstCode, secondCode, restoredCode] = await Promise.all(
      [now, first, second, restored].map(async (bundle) => await codeOf(bundle))
    );

    expect({
      first: first.revision,
      differs: firstCode !== nowCode,
      secondIsNow: secondCode === nowCode,
      calls,
      restoredIsFirst: restoredCode === firstCode,
      missing: await failure(async () => await chats.preview(chatId, app, 9)),
    }).toStrictEqual({
      first: readOnlyRevision,
      differs: true,
      secondIsNow: true,
      calls: [undefined, undefined],
      restoredIsFirst: true,
      missing: "app.version_not_found",
    });
  });

  it("previews the version a draft was proposed as, at the draft's revision, its calls running there", async () => {
    const builder = await signedInApi(idp, "builder");
    const other = await signedInApi(idp, "builder");
    const { app, chatId, revision } = await twoVersions(builder);
    await builder.api.apps.members.add(app, {
      type: "person",
      id: other.userId,
      role: "builder",
    });
    const { chats } = builder.api;
    // Proposed, the draft changes nothing: its preview shows the version
    // it became, at the draft's revision, its calls on that version.
    const version = await chats.proposeDraft(chatId, app, "Two");
    const latest = await chats.preview(chatId, app);
    const latestAt =
      latest.refresh === undefined ? latest.revision : shownAt(latest.refresh);
    const latestRequest = await requestFor(
      builder,
      { chatId, app, revision: latestAt },
      "notes.titles"
    );

    expect({
      version,
      drafts: changesOf(await chats.drafts(chatId)),
      latest: {
        revision: latest.revision,
        appVersion: latest.refresh?.appVersion,
        at: latestAt,
        titles: outcome(await previewCall(builder, chatId, app, latestRequest)),
      },
      // Another builder of the App, through a chat that isn't theirs.
      othersChat: await failure(
        async () => await other.api.chats.preview(chatId, app)
      ),
    }).toStrictEqual({
      version: 2,
      drafts: [{ changed: [], revision: revision + 1 }],
      latest: {
        revision: revision + 1,
        appVersion: 2,
        at: { appVersion: 2 },
        titles: [],
      },
      othersChat: "agent.chat_not_found",
    });
  });

  it("are kept when the person discards the draft, which the agent's next write can't undo, and restore it", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app, chatId, write, revision } = await twoVersions(builder);
    const { chats } = builder.api;
    const before = await chats.draftVersions(chatId, app);

    await chats.discardDraft(chatId, app);
    const drafts = await chats.drafts(chatId);
    const after = await chats.draftVersions(chatId, app);
    // The agent's write that read the draft before it was discarded.
    const stale = await failure(
      async () =>
        await write({ "src/routes/index.tsx": desk("Three") }, revision)
    );
    const afterStale = await chats.drafts(chatId);
    const restored = await chats.restoreDraftVersion(chatId, app, 2);
    const [back] = await chats.drafts(chatId);
    const logged = await allEvents();

    expect({
      // Listed still, changing nothing once discarded, its revision on.
      drafts: changesOf(drafts),
      versionsKept: after,
      staleLanded: stale === "ok",
      afterStale: changesOf(afterStale),
      restored: restored.restoredFrom,
      back: changesOf(back === undefined ? [] : [back]),
      audited: logged
        .filter(
          ({ action, target }) =>
            action === "chat.draft_discarded" && target?.id === chatId
        )
        .map(({ actor, detail }) => ({
          by: actor.type === "person" ? actor.userId : actor.type,
          app: detail.app,
        })),
    }).toStrictEqual({
      drafts: [{ changed: [], revision: revision + 1 }],
      versionsKept: before,
      staleLanded: false,
      afterStale: [{ changed: [], revision: revision + 1 }],
      restored: 2,
      back: [{ changed: ["src/routes/index.tsx"], revision: revision + 2 }],
      audited: [{ by: builder.userId, app }],
    });
  });

  it("are only for the chat's person while they build the App", async () => {
    const owner = await signedInApi(idp, "builder");
    const { id } = await owner.api.apps.create({ name: "Desk" });
    await release(owner, id, deskFiles("Released"));
    const app: AppId = appIdSchema.parse(id);
    const [builder, other, outsider] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
    ]);
    for (const person of [builder, other]) {
      // oxlint-disable-next-line no-await-in-loop -- one member after the other
      await owner.api.apps.members.add(app, {
        type: "person",
        id: person.userId,
        role: "builder",
      });
    }
    const { chatId } = await chatWithDraft(builder, app, {
      "src/routes/index.tsx": desk("One"),
    });
    /** How each way in to the chat's versions went for `person`. */
    const outcomes = async (person: Person) => ({
      list: await failure(
        async () => await person.api.chats.draftVersions(chatId, app)
      ),
      preview: await failure(
        async () => await person.api.chats.preview(chatId, app, 1)
      ),
      restore: await failure(
        async () => await person.api.chats.restoreDraftVersion(chatId, app, 1)
      ),
      discard: await failure(async () => {
        await person.api.chats.discardDraft(chatId, app);
      }),
    });

    const another = await outcomes(other);
    const notMember = await outcomes(outsider);
    await owner.api.apps.members.add(app, {
      type: "person",
      id: builder.userId,
      role: "user",
    });
    const demoted = await outcomes(builder);

    expect({ another, notMember, demoted }).toStrictEqual({
      another: {
        list: "agent.chat_not_found",
        preview: "agent.chat_not_found",
        restore: "agent.chat_not_found",
        discard: "agent.chat_not_found",
      },
      notMember: {
        list: "app.not_found",
        preview: "app.not_found",
        restore: "app.not_found",
        discard: "app.not_found",
      },
      demoted: {
        list: "role.forbidden",
        preview: "role.forbidden",
        restore: "role.forbidden",
        discard: "role.forbidden",
      },
    });
  });

  it("are erased with their chat, and another chat's are kept", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app, chatId } = await twoVersions(builder);
    const kept = await chatWithDraft(builder, app, {
      "src/routes/index.tsx": desk("Elsewhere"),
    });
    const before = await keptRows(builder, chatId);

    await builder.api.chats.remove(chatId);

    expect({
      before,
      after: await keptRows(builder, chatId),
      other: await keptRows(builder, kept.chatId),
    }).toStrictEqual({
      before: {
        chat_draft_versions: 2,
        chat_draft_version_files: 2,
        chat_draft_contents: 2,
      },
      after: {
        chat_draft_versions: 0,
        chat_draft_version_files: 0,
        chat_draft_contents: 0,
      },
      other: {
        chat_draft_versions: 1,
        chat_draft_version_files: 1,
        chat_draft_contents: 1,
      },
    });
  });
});
