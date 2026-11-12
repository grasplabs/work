import { readOnlyRevision } from "@grasp-os/shared/chat";
import { appIdSchema, chatIdSchema } from "@grasp-os/shared/ids";
import type { AppId, ChatId } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { readDraft, saveDraft } from "../src/app-drafts.ts";
import { testApp } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { agentWriting } from "./draft-writers.ts";
import { mockIdp } from "./idp.ts";
import { loadFrame, modulePartsOf } from "./page-frames.ts";
import type { Framed } from "./page-frames.ts";
import { failure } from "./sealed-apps.ts";
import { signedInApi } from "./sign-in.ts";

// An App's draft is one, shared by every builder of the App and by the
// agents of their chats (app-drafts.ts). Each agent turn's writes are one
// undo point, as the turn left the draft; a restore is one too. These
// tests start from the ways it can fail: two writers overwriting each
// other (two people's chats writing from the same read), a turn's writes
// split into points or folded into another's, a restore that rewrites
// history, an undo point's preview that runs anything, someone who
// doesn't build the App reading or changing the draft, and what a chat
// worked on told to anyone but its person.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/**
 * The code a preview's frame runs: each module's content address. Not its
 * frame's artifact, which a point opened read-only has of its own
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

/** A Desk App of `owner`'s, released at version 1. */
const deskOf = async (owner: Person): Promise<AppId> => {
  const { id } = await owner.api.apps.create({ name: "Desk" });
  await release(owner, id, deskFiles("Released"));
  return appIdSchema.parse(id);
};

/** A new chat of `person`'s. */
const chatOf = async (person: Person): Promise<ChatId> => {
  const chat = await person.api.chats.create("Build");
  return chatIdSchema.parse(chat.id);
};

/**
 * Writes the Desk page saying `marker` into `app`'s draft as `person`'s
 * chat `chatId`'s agent does in turn `turnId`, over `revision` (the
 * draft's now when not named): its write refused with `app.conflict`
 * once the draft moved past it.
 */
const agentWrites = async (
  person: Person,
  { app, chatId }: { app: AppId; chatId: ChatId },
  turnId: string,
  marker: string,
  revision?: number
): Promise<void> => {
  const now = await readDraft(env, app);
  await saveDraft(
    env,
    app,
    { ...now, base: 1, revision: revision ?? now.revision },
    { changes: { "src/routes/index.tsx": desk(marker) }, unchanged: [] },
    await agentWriting(person, chatId, { turnId, callId: `call-${turnId}` })
  );
};

/** How many rows of `app`'s undo points, their files and contents there are. */
const keptRows = async (app: AppId) =>
  Object.fromEntries(
    await Promise.all(
      ["app_draft_points", "app_draft_point_files", "app_draft_contents"].map(
        async (table) => {
          const row = await env.DB.prepare(
            `SELECT count(*) AS n FROM ${table} WHERE app_id = ?`
          )
            .bind(app)
            .first<{ n: number }>();
          return [table, row?.n ?? 0] as const;
        }
      )
    )
  );

/** A builder of `app` of `owner`'s. */
const builderOf = async (owner: Person, app: AppId): Promise<Person> => {
  const builder = await signedInApi(idp, "builder");
  await owner.api.apps.members.add(app, {
    type: "person",
    id: builder.userId,
    role: "builder",
  });
  return builder;
};

describe("an App's draft", { timeout: 180_000 }, () => {
  it("is one for every builder's chat: a write over a revision another moved past is refused, and the writer reads again", async () => {
    const owner = await signedInApi(idp, "builder");
    const app = await deskOf(owner);
    const other = await builderOf(owner, app);
    const mine = { app, chatId: await chatOf(owner) };
    const theirs = { app, chatId: await chatOf(other) };

    await agentWrites(owner, mine, "turn-a1", "Mine");
    const read = await readDraft(env, app);
    await agentWrites(owner, mine, "turn-a2", "Mine again");
    // Their agent writes from what it read before: refused, nothing lost.
    const stale = await failure(async () => {
      await agentWrites(other, theirs, "turn-b1", "Theirs", read.revision);
    });
    const afterStale = await readDraft(env, app);
    // It reads again, and writes over the draft as it is now.
    await agentWrites(other, theirs, "turn-b1", "Theirs");
    // Two writes from one read, at once: one lands, the other is refused.
    const both = await Promise.all([
      failure(async () => {
        await agentWrites(owner, mine, "turn-a3", "Race A");
      }),
      failure(async () => {
        await agentWrites(other, theirs, "turn-b2", "Race B");
      }),
    ]);
    const draft = await owner.api.apps.drafts.get(app);
    const seen = await other.api.apps.drafts.get(app);
    const mineWorked = await owner.api.chats.worked(mine.chatId);
    const theirsWorked = await other.api.chats.worked(theirs.chatId);

    expect({
      stale,
      kept: afterStale.changes["src/routes/index.tsx"],
      landed: both.filter((outcome) => outcome === "ok").length,
      refused: both.filter((outcome) => outcome === "app.conflict").length,
      revision: draft.revision,
      shared: seen,
      mine: mineWorked.map(({ id }) => id),
      theirs: theirsWorked.map(({ id }) => id),
    }).toStrictEqual({
      stale: "app.conflict",
      kept: desk("Mine again"),
      landed: 1,
      refused: 1,
      revision: 4,
      shared: draft,
      mine: [app],
      theirs: [app],
    });
  });

  it("lists with each undo point the files it touched, against the point before it, and how many it changes", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await deskOf(builder);
    const chatId = await chatOf(builder);
    const writes = async (
      turnId: string,
      changes: Record<string, string | null>
    ): Promise<void> => {
      await saveDraft(
        env,
        app,
        await readDraft(env, app),
        { changes, unchanged: [] },
        await agentWriting(builder, chatId, { turnId })
      );
    };

    await writes("turn-1", { "src/routes/index.tsx": desk("One") });
    await writes("turn-2", { "src/routes/about.tsx": desk("About") });
    await writes("turn-3", {
      "src/routes/index.tsx": desk("Two"),
      "src/routes/about.tsx": null,
    });
    const listed = async (before?: number) => {
      const points = await builder.api.apps.drafts.points(app, before);
      return points.map(({ number, touched, changes }) => ({
        number,
        touched,
        changes,
      }));
    };

    expect({
      newest: await listed(),
      // The page before point 3: its newest still against the point
      // before it.
      older: await listed(3),
    }).toStrictEqual({
      newest: [
        {
          number: 3,
          touched: ["src/routes/about.tsx", "src/routes/index.tsx"],
          // Its deletion of about.tsx is a change too.
          changes: 2,
        },
        { number: 2, touched: ["src/routes/about.tsx"], changes: 2 },
        { number: 1, touched: ["src/routes/index.tsx"], changes: 1 },
      ],
      older: [
        { number: 2, touched: ["src/routes/about.tsx"], changes: 2 },
        { number: 1, touched: ["src/routes/index.tsx"], changes: 1 },
      ],
    });
  });

  it("lists the newest 50 undo points, the oldest of them still against the point before it, and the rest page by page", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await deskOf(builder);
    const chatId = await chatOf(builder);
    const pointsMade = 52;
    for (let turn = 1; turn <= pointsMade; turn += 1) {
      const changes: Record<string, string> =
        turn === 1 ? { "notes/a.md": "A\n" } : { "notes/b.md": `${turn}\n` };
      // oxlint-disable-next-line no-await-in-loop -- one turn after the other
      await saveDraft(
        env,
        app,
        // oxlint-disable-next-line no-await-in-loop -- read as each turn writes
        await readDraft(env, app),
        { changes, unchanged: [] },
        // oxlint-disable-next-line no-await-in-loop -- as each turn writes
        await agentWriting(builder, chatId, { turnId: `turn-${turn}` })
      );
    }

    const newest = await builder.api.apps.drafts.points(app);
    const oldest = newest.at(-1);
    const rest = await builder.api.apps.drafts.points(app, oldest?.number);

    expect({
      newest: newest.length,
      oldest: { number: oldest?.number, touched: oldest?.touched },
      rest: rest.map(({ number, touched }) => ({ number, touched })),
    }).toStrictEqual({
      newest: 50,
      oldest: { number: 3, touched: ["notes/b.md"] },
      rest: [
        { number: 2, touched: ["notes/b.md"] },
        { number: 1, touched: ["notes/a.md"] },
      ],
    });
  });

  it("keeps one undo point per agent turn, as the turn left the draft, and each restore as a new one", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await deskOf(builder);
    const chat = { app, chatId: await chatOf(builder) };
    const { drafts } = builder.api.apps;
    const numbers = async () => {
      const points = await drafts.points(app);
      return points.map(({ number }) => number);
    };

    // One turn, three writes: one point, the last.
    await agentWrites(builder, chat, "turn-1", "One");
    await agentWrites(builder, chat, "turn-1", "Two");
    await agentWrites(builder, chat, "turn-1", "Three");
    const [first] = await drafts.points(app);
    const firstPreview = await drafts.preview(app);
    const afterFirst = await keptRows(app);
    // A turn cut short after one write: what it wrote is its point.
    await agentWrites(builder, chat, "turn-2", "Cut");
    await agentWrites(builder, chat, "turn-3", "Four");
    // A restore while a turn writes: its next write is a point of its own.
    await agentWrites(builder, chat, "turn-4", "Five");
    const before = await drafts.get(app);
    const restored = await drafts.restorePoint(app, 1, before.revision);
    const restoredPreview = await drafts.preview(app);
    await agentWrites(builder, chat, "turn-4", "Six");
    const points = await drafts.points(app);
    // A turn that writes what an earlier point holds, then writes over
    // it: the earlier point still reads it.
    await agentWrites(builder, chat, "turn-5", "Three");
    await agentWrites(builder, chat, "turn-5", "Seven");
    const firstAfter = await drafts.preview(app, 1);

    expect({
      first: {
        number: first?.number,
        revision: first?.revision,
        personId: first?.personId,
        chatId: first?.chatId,
        callId: first?.callId,
      },
      // What the turn wrote over is no undo point: one file, kept once.
      afterFirst,
      restored: {
        number: restored.number,
        restoredFrom: restored.restoredFrom,
        chatId: restored.chatId,
        sameContent: restored.contentHash === first?.contentHash,
      },
      restoredIsFirst:
        (await codeOf(restoredPreview)) === (await codeOf(firstPreview)),
      numbers: points.map(({ number }) => number),
      kept: points.at(-1),
      after: await numbers(),
      earlierHeld: (await codeOf(firstAfter)) === (await codeOf(firstPreview)),
    }).toStrictEqual({
      first: {
        number: 1,
        revision: 3,
        personId: builder.userId,
        chatId: chat.chatId,
        callId: "call-turn-1",
      },
      afterFirst: {
        app_draft_points: 1,
        app_draft_point_files: 1,
        app_draft_contents: 1,
      },
      restored: {
        number: 5,
        restoredFrom: 1,
        chatId: null,
        sameContent: true,
      },
      restoredIsFirst: true,
      numbers: [6, 5, 4, 3, 2, 1],
      kept: first,
      after: [7, 6, 5, 4, 3, 2, 1],
      earlierHeld: true,
    });
  });

  it("previews an undo point as it was, read-only, and refuses one there isn't", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await deskOf(builder);
    const chat = { app, chatId: await chatOf(builder) };
    const { drafts } = builder.api.apps;
    await agentWrites(builder, chat, "turn-1", "One");
    await agentWrites(builder, chat, "turn-2", "Two");

    const now = await drafts.preview(app);
    const first = await drafts.preview(app, 1);
    const second = await drafts.preview(app, 2);

    const [nowCode, firstCode, secondCode] = await Promise.all(
      [now, first, second].map(async (bundle) => await codeOf(bundle))
    );

    expect({
      first: first.revision,
      differs: firstCode !== nowCode,
      secondIsNow: secondCode === nowCode,
      // A point's page, the latest's (the draft as it is now) too, gets
      // no lease: nothing a point opened read-only calls runs.
      leases: [now, first, second].map(({ lease }) => lease !== undefined),
      missing: await failure(async () => await drafts.preview(app, 9)),
    }).toStrictEqual({
      first: readOnlyRevision,
      differs: true,
      secondIsNow: true,
      leases: [true, false, false],
      missing: "app.version_not_found",
    });
  });

  it("previews a published version as it is, read-only, and refuses one there isn't", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await deskOf(builder);
    const chat = { app, chatId: await chatOf(builder) };
    const { drafts } = builder.api.apps;
    // The draft's preview with no changes shows version 1.
    const released = await drafts.preview(app);
    // The draft moves on from version 1, so its preview isn't it any more.
    await agentWrites(builder, chat, "turn-1", "One");

    const now = await drafts.preview(app);
    const version = await drafts.preview(app, undefined, 1);
    const [releasedCode, nowCode, versionCode] = await Promise.all(
      [released, now, version].map(async (bundle) => await codeOf(bundle))
    );

    expect({
      revision: version.revision,
      released: versionCode === releasedCode,
      differs: versionCode !== nowCode,
      // Opened read-only: no lease, so it calls nothing.
      lease: version.lease,
      missing: await failure(
        async () => await drafts.preview(app, undefined, 9)
      ),
    }).toStrictEqual({
      revision: readOnlyRevision,
      released: true,
      differs: true,
      lease: undefined,
      missing: "app.version_not_found",
    });
  });

  it("keeps its undo points when a builder discards it, which a write that read it before can't undo", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await deskOf(builder);
    const chat = { app, chatId: await chatOf(builder) };
    const { drafts } = builder.api.apps;
    await agentWrites(builder, chat, "turn-1", "One");
    await agentWrites(builder, chat, "turn-2", "Two");
    const { revision } = await drafts.get(app);
    const before = await drafts.points(app);

    // Over a revision it moved past: refused, nothing discarded.
    const staleDiscard = await failure(async () => {
      await drafts.discard(app, revision - 1);
    });
    await drafts.discard(app, revision);
    const discarded = await drafts.get(app);
    // The agent's write that read the draft before it was discarded.
    const stale = await failure(async () => {
      await agentWrites(builder, chat, "turn-3", "Three", revision);
    });
    const restored = await drafts.restorePoint(app, 2, revision + 1);
    const back = await drafts.get(app);
    const after = await drafts.points(app);
    const logged = await allEvents();

    expect({
      staleDiscard,
      discarded: {
        changed: discarded.changed,
        revision: discarded.revision,
      },
      pointsKept: after.slice(1),
      stale,
      restored: restored.restoredFrom,
      back: { changed: back.changed, revision: back.revision },
      audited: logged
        .filter(
          ({ action, target }) =>
            action === "app.draft.discarded" && target?.id === app
        )
        .map(({ actor }) =>
          actor.type === "person" ? actor.userId : actor.type
        ),
    }).toStrictEqual({
      staleDiscard: "app.conflict",
      discarded: { changed: [], revision: revision + 1 },
      pointsKept: before,
      stale: "app.conflict",
      restored: 2,
      back: { changed: ["src/routes/index.tsx"], revision: revision + 2 },
      audited: [builder.userId],
    });
  });

  it("is only for the App's builders, while they build it", async () => {
    const owner = await signedInApi(idp, "builder");
    const app = await deskOf(owner);
    const [builder, outsider] = await Promise.all([
      builderOf(owner, app),
      signedInApi(idp, "builder"),
    ]);
    await agentWrites(owner, { app, chatId: await chatOf(owner) }, "t", "One");
    /** How each way in to the draft went for `person`. */
    const outcomes = async (person: Person) => {
      const { drafts } = person.api.apps;
      return {
        get: await failure(async () => await drafts.get(app)),
        points: await failure(async () => await drafts.points(app)),
        preview: await failure(async () => await drafts.preview(app, 1)),
        restore: await failure(
          async () => await drafts.restorePoint(app, 1, 1)
        ),
      };
    };

    const another = await outcomes(builder);
    const notMember = await outcomes(outsider);
    await owner.api.apps.members.add(app, {
      type: "person",
      id: builder.userId,
      role: "user",
    });
    const demoted = await outcomes(builder);

    expect({ another, notMember, demoted }).toStrictEqual({
      another: { get: "ok", points: "ok", preview: "ok", restore: "ok" },
      notMember: {
        get: "app.not_found",
        points: "app.not_found",
        preview: "app.not_found",
        restore: "app.not_found",
      },
      demoted: {
        get: "role.forbidden",
        points: "role.forbidden",
        preview: "role.forbidden",
        restore: "role.forbidden",
      },
    });
  });

  it("commits nothing of a builder who stops building the App while they write, and records each write it commits as the writer's", async () => {
    const owner = await signedInApi(idp, "builder");
    const app = await deskOf(owner);
    const builder = await builderOf(owner, app);
    const chatId = await chatOf(builder);
    const write = async (marker: string, admit?: () => Promise<void>) =>
      await failure(async () => {
        await saveDraft(
          env,
          app,
          await readDraft(env, app),
          { changes: { "src/routes/index.tsx": desk(marker) }, unchanged: [] },
          await agentWriting(builder, chatId),
          admit
        );
      });

    const kept = await write("Kept");
    // Taken off the App's builders after the write was let in, before it
    // commits.
    const demoted = await write("Lost", async () => {
      await owner.api.apps.members.add(app, {
        type: "person",
        id: builder.userId,
        role: "user",
      });
    });
    const draft = await readDraft(env, app);
    const events = await allEvents();

    expect({
      kept,
      demoted,
      page: draft.changes["src/routes/index.tsx"],
      revision: draft.revision,
      recorded: events
        .filter(
          ({ action, target }) =>
            action === "app.draft.defined" && target?.id === app
        )
        .map(({ actor, detail }) => ({ actor, detail })),
    }).toMatchObject({
      kept: "ok",
      demoted: "role.forbidden",
      page: desk("Kept"),
      revision: 1,
      recorded: [
        { actor: { userId: builder.userId }, detail: { revision: 1 } },
      ],
    });
  });

  it("tells a chat's own person alone what its agent worked on, the latest first", async () => {
    const owner = await signedInApi(idp, "builder");
    const first = await deskOf(owner);
    const other = await deskOf(owner);
    const builder = await builderOf(owner, first);
    const chatId = await chatOf(owner);
    const quiet = await chatOf(owner);

    await agentWrites(owner, { app: first, chatId }, "turn-1", "One");
    // A moment later, so the two writes don't share their millisecond.
    await scheduler.wait(5);
    await agentWrites(owner, { app: other, chatId }, "turn-2", "Other");
    const worked = await owner.api.chats.worked(chatId);

    expect({
      worked: worked.map(({ kind, id, callId }) => ({ kind, id, callId })),
      quiet: await owner.api.chats.worked(quiet),
      someoneElse: await failure(
        async () => await builder.api.chats.worked(chatId)
      ),
    }).toStrictEqual({
      worked: [
        { kind: "app", id: other, callId: "call-turn-2" },
        { kind: "app", id: first, callId: "call-turn-1" },
      ],
      quiet: [],
      someoneElse: "agent.chat_not_found",
    });
  });
});
