import { definitionText } from "@grasp-os/sdk/definition";
import { appIdSchema, chatIdSchema } from "@grasp-os/shared/ids";
import { describe, expect, it } from "vite-plus/test";

import { openTestRun } from "./agent-chat.ts";
import { commitApp, redefined, testApp } from "./app-definitions.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { deskFiles } from "./preview-drafts.ts";
import { chatsOf, chatWithDraft } from "./previews.ts";
import { failure } from "./sealed-apps.ts";
import { signedInApi } from "./sign-in.ts";

// The App's code view reads the files of a chat's draft as the chat's
// agent reads them (`chats.draftFiles`): its changes over the version it
// is over, each write as it lands, or the App's latest version while the
// chat has no draft. The ways it can fail: a write that doesn't show, a
// deleted file that still does, and someone else reading the draft, by
// another person's chat or once they no longer build the App.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** Version 1 of the App: its registration, schema and one page. */
const released = deskFiles("Released");
const { "src/routes/index.tsx": _page, ...unpageed } = released.files;

/** The App's definition, as a builder's second version renames it. */
const renamed = redefined(released, (definition) => ({
  ...definition,
  name: "Desk 2",
}));

/** A server file the draft adds. */
const notes = (limit: number): string => `export const limit = ${limit};\n`;

/** An App of `owner`'s, published at version 1 (`released`). */
const deskOf = async (owner: Person) => {
  const { id } = await owner.api.apps.create({ name: "Desk" });
  await release(owner, id, released);
  return appIdSchema.parse(id);
};

describe("a chat's draft files, for the App's code view", () => {
  it("are the draft's as each write lands, and the App's latest version in a chat without one", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await deskOf(builder);
    const { chatId, revision, write } = await chatWithDraft(builder, app, {
      "server/notes.ts": notes(10),
      "src/routes/index.tsx": null,
    });
    const { chats } = builder.api;

    const first = await chats.draftFiles(chatId, app);
    await write({ "server/notes.ts": notes(25) }, revision);
    const second = await chats.draftFiles(chatId, app);
    const empty = await chats.create("Nothing written");
    const before = await chats.draftFiles(empty.id, app);
    await commitApp(builder.api.apps.files, app, renamed, "Rename");
    const latest = await chats.draftFiles(empty.id, app);

    expect({ first, second, before, latest }).toStrictEqual({
      first: { ...unpageed, "server/notes.ts": notes(10) },
      second: { ...unpageed, "server/notes.ts": notes(25) },
      before: released.files,
      latest: renamed.files,
    });
  });

  it("say a draft changes the App when it changes only its definition's IDs, no file", async () => {
    const builder = await signedInApi(idp, "builder");
    const notesApp = testApp({
      name: "Notes",
      tables: { notes: { fields: { title: "v.string()" } } },
    });
    const { id } = await builder.api.apps.create({ name: "Notes" });
    await release(builder, id, notesApp);
    const app = appIdSchema.parse(id);
    const { chatId, revision } = await chatWithDraft(builder, app, {});
    // The title's ID changed, its name and type not: the same code.
    const [table] = notesApp.definition.tables;
    const reIded = {
      ...notesApp.definition,
      tables: table
        ? [
            {
              ...table,
              fields: table.fields.map((field) => ({
                ...field,
                id: "field:notes.renumbered",
              })),
            },
          ]
        : [],
    };
    const before = await builder.api.chats.drafts(chatId);
    await chatsOf(builder).saveDraft(
      chatIdSchema.parse(chatId),
      app,
      1,
      {},
      [],
      revision,
      {
        runId: await openTestRun(chatsOf(builder), chatIdSchema.parse(chatId)),
      },
      definitionText(reIded)
    );
    const after = await builder.api.chats.drafts(chatId);
    expect({
      before: before.map(({ changed, definitionChanged }) => [
        changed,
        definitionChanged,
      ]),
      after: after.map(({ changed, definitionChanged }) => [
        changed,
        definitionChanged,
      ]),
    }).toStrictEqual({
      before: [[[], false]],
      after: [[[], true]],
    });
  });

  it("are only for the chat's person while they build the App", async () => {
    const owner = await signedInApi(idp, "builder");
    const app = await deskOf(owner);
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
      "server/notes.ts": notes(10),
    });
    const read = async (person: Person): Promise<string> =>
      await failure(async () => await person.api.chats.draftFiles(chatId, app));

    const own = await read(builder);
    const another = await read(other);
    const notMember = await read(outsider);
    await owner.api.apps.members.add(app, {
      type: "person",
      id: builder.userId,
      role: "user",
    });
    const demoted = await read(builder);

    expect({ own, another, notMember, demoted }).toStrictEqual({
      own: "ok",
      another: "agent.chat_not_found",
      notMember: "app.not_found",
      demoted: "role.forbidden",
    });
  });
});
