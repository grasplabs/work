import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId, ChatId } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { chatsOf, chatWithDraft, requestFor } from "./previews.ts";
import { failure } from "./sealed-apps.ts";
import { signedInApi } from "./sign-in.ts";

// Every write of a chat's draft of an App is kept as a version: listed,
// previewed read-only and restored as a new version, only by the chat's
// person while they build the App, and gone with the chat. These tests
// start from the ways it can fail: a write lost or kept out of order when
// writes land together, a restore that rewrites history, an earlier
// version's preview that runs or changes anything, someone else (or a
// person who no longer builds the App) reading another's versions, and
// versions that outlive their chat.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** The Desk screen, saying `marker`. */
const desk = (
  marker: string
): string => `import { useQuery } from "@grasp-os/sdk/react";
import { api } from "#grasp";

export default function Desk() {
  const titles = useQuery(api.notes.titles, {});
  return <main>${marker}: {titles?.join(", ")}</main>;
}
`;

/** An App of spec 8's layout whose one screen says `marker` and reads its notes. */
const deskFiles = (marker: string): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string().min(1).max(200) }),
});
`,
  "operations/notes.ts": `import { v } from "@grasp-os/sdk";
import { query } from "#grasp/server";

export const titles = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).map((note) => note.title),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { titles } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: "Desk",
  schema,
  access: { tables: { notes: { read: "appMembers", write: "appMembers" } } },
  operations: { notes: { titles } },
  internalOperations: {},
  screens: [{ name: "desk", path: "/", source: "screens/desk.tsx" }],
  uses: [],
});
`,
  "screens/desk.tsx": desk(marker),
});

/** A Desk App of `builder`'s, released, and a chat with two writes of its draft. */
const twoVersions = async (builder: Person) => {
  const { id } = await builder.api.apps.create({ name: "Desk" });
  await release(builder, id, deskFiles("Released"));
  const app = appIdSchema.parse(id);
  const draft = await chatWithDraft(builder, app, {
    "screens/desk.tsx": desk("One"),
  });
  const revision = await draft.write(
    { "screens/desk.tsx": desk("Two") },
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
        async () => await write({ "screens/desk.tsx": desk("Three") }, revision)
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
    const { app, chatId, revision } = await twoVersions(builder);
    const { chats } = builder.api;
    const [, one] = await chats.draftVersions(chatId, app);

    const now = await chats.preview(chatId, app);
    const first = await chats.preview(chatId, app, undefined, 1);
    const second = await chats.preview(chatId, app, undefined, 2);
    // A call of the earlier version's screen: refused, as it is past.
    const request = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.titles"
    );
    const call = await failure(
      async () =>
        await chats.previewFunction(chatId, app, first.revision, request)
    );
    await chats.restoreDraftVersion(chatId, app, 1);
    const restored = await chats.preview(chatId, app);

    expect({
      first: { revision: first.revision, screens: first.screens },
      differs: first.artifact !== now.artifact,
      secondIsNow: second.artifact === now.artifact,
      call,
      restoredIsFirst: restored.artifact === first.artifact,
      missing: await failure(
        async () => await chats.preview(chatId, app, undefined, 9)
      ),
    }).toStrictEqual({
      first: { revision: one?.revision, screens: ["desk"] },
      differs: true,
      secondIsNow: true,
      call: "app.preview_outdated",
      restoredIsFirst: true,
      missing: "app.version_not_found",
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
      "screens/desk.tsx": desk("One"),
    });
    /** How each way in to the chat's versions went for `person`. */
    const outcomes = async (person: Person) => ({
      list: await failure(
        async () => await person.api.chats.draftVersions(chatId, app)
      ),
      preview: await failure(
        async () => await person.api.chats.preview(chatId, app, undefined, 1)
      ),
      restore: await failure(
        async () => await person.api.chats.restoreDraftVersion(chatId, app, 1)
      ),
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
      },
      notMember: {
        list: "app.not_found",
        preview: "app.not_found",
        restore: "app.not_found",
      },
      demoted: {
        list: "role.forbidden",
        preview: "role.forbidden",
        restore: "role.forbidden",
      },
    });
  });

  it("are erased with their chat, and another chat's are kept", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app, chatId } = await twoVersions(builder);
    const kept = await chatWithDraft(builder, app, {
      "screens/desk.tsx": desk("Elsewhere"),
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
