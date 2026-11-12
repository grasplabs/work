import { definitionText } from "@grasp-os/runtime/definition";
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { readDraft, saveDraft } from "../src/app-drafts.ts";
import { commitApp, redefined, testApp } from "./app-definitions.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { deskFiles } from "./preview-drafts.ts";
import { chatWithDraft } from "./previews.ts";
import { failure } from "./sealed-apps.ts";
import { signedInApi } from "./sign-in.ts";

// The App's code view reads the files of the App's draft as its writers
// read them (`apps.drafts.files`): its changes over the version it is
// over, each write as it lands, or the App's live version while the draft
// changes nothing. The ways it can fail: a write that doesn't show, a
// deleted file that still does, and someone reading the draft who doesn't
// build the App, or no longer does.

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

describe("an App's draft files, for the App's code view", () => {
  it("are the draft's as each write lands, and the App's live version while it changes nothing", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await deskOf(builder);
    const { drafts } = builder.api.apps;
    const before = await drafts.files(app);
    const { revision, write } = await chatWithDraft(builder, app, {
      "server/notes.ts": notes(10),
      "src/routes/index.tsx": null,
    });

    const first = await drafts.files(app);
    const written = await write({ "server/notes.ts": notes(25) }, revision);
    const second = await drafts.files(app);
    await drafts.discard(app, written);
    const discarded = await drafts.files(app);
    // A version committed, not live: the draft stays over the live one.
    await commitApp(builder.api.apps.files, app, renamed, "Rename");
    const committed = await drafts.files(app);

    expect({ before, first, second, discarded, committed }).toStrictEqual({
      before: released.files,
      first: { ...unpageed, "server/notes.ts": notes(10) },
      second: { ...unpageed, "server/notes.ts": notes(25) },
      discarded: released.files,
      committed: released.files,
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
    const { chatId } = await chatWithDraft(builder, app, {});
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
    const before = await builder.api.apps.drafts.get(app);
    await saveDraft(
      env,
      app,
      await readDraft(env, app),
      { changes: {}, unchanged: [], definition: definitionText(reIded) },
      { chat: { personId: builder.userId, chatId, turnId: null, callId: null } }
    );
    const after = await builder.api.apps.drafts.get(app);
    expect({
      before: [before.changed, before.definitionChanged],
      after: [after.changed, after.definitionChanged],
    }).toStrictEqual({
      before: [[], false],
      after: [[], true],
    });
  });

  it("are for whoever builds the App, while they build it", async () => {
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
    await chatWithDraft(builder, app, {
      "server/notes.ts": notes(10),
    });
    const read = async (person: Person): Promise<string> =>
      await failure(async () => await person.api.apps.drafts.files(app));

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
      // The App's draft, which every builder of it shares.
      another: "ok",
      notMember: "app.not_found",
      demoted: "role.forbidden",
    });
  });
});
