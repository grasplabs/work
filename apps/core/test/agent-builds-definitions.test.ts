import { appErrors } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import { roleErrors } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { draftSummary, readDraft, saveDraft } from "../src/app-drafts.ts";
import {
  draftDefinitionOf,
  idp,
  restyled,
  returned,
  setUp,
  tryEach,
  findApp,
} from "./agent-builds-harness.ts";
import { codeResults, codeStep, says } from "./agent-chat.ts";
import { commitApp, definedWith, redefined } from "./app-definitions.ts";
import { published, release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdpWith } from "./idp.ts";
import { notesFiles } from "./notes-client-app.ts";
import { calledAs } from "./sealed-apps.ts";
import { signedInApi } from "./sign-in.ts";

// `env.build` in a chat's code: the chat's agent building Apps for its
// person in a draft of its own, and repairing what its checks report.
// These tests start from the ways it can fail: the agent builds past what
// its person may do (an App they don't build, or any App for someone who
// doesn't build), or not at all for someone who does; a chat that read
// restricted data writes it into code others read; the agent writes a
// workflow into an App, whose calls no admin approves binding by binding;
// the agent's draft and a builder's commits overwrite each other; a draft
// that doesn't pass reaches the App; and a repair loop that never ends.

mockIdpWith(idp);

/**
 * `builder`'s change of App `app`'s draft over version `base`, written as
 * they write one: the draft over that version, whatever is live.
 */
const draftOver = async (
  builder: { userId: string },
  app: string,
  base: number
): Promise<void> => {
  await saveDraft(
    env,
    appIdSchema.parse(app),
    { ...(await readDraft(env, app)), base },
    { changes: { "notes.md": "Notes\n" }, unchanged: [] },
    {
      by: {
        userId: builder.userId,
        role: "builder",
        teams: [],
        staff: false,
        actor: actorOf({ userId: builder.userId, staff: false }),
      },
      detail: {},
    }
  );
};

/** Code that writes the App `app`'s draft, and calls an App's function it doesn't have. */
const writeAndCall = (app: string): string =>
  tryEach({
    write: `(await env.build.write(${JSON.stringify(app)}, { "notes.md": "new" }, { revision: (await env.build.files(${JSON.stringify(app)})).revision })).changed`,
    call: `await env.build.call("app_refused", "count")`,
  });

describe("building Apps from a chat", { timeout: 120_000 }, () => {
  it("changes a definition whose table holds records, says what each change does to them, and records each change", async () => {
    // Version 1: the Notes App, current, with a note in its store, and an
    // answer its definition kept for a category it no longer has.
    const { builder, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const [app] = (await env.apps.list()).filter(({ name }) => name === "Notes");
        const steps = {};
        // A field the released version has: renamed by its ID, its values
        // following it as the version is published, and back.
        const away = await env.build.define(app.id, { op: "renameField", table: "notes", field: "title", name: "heading" });
        const back = await env.build.define(app.id, { op: "renameField", table: "notes", field: "heading", name: "title" });
        steps.released = away.ok && back.ok && away.plan.refused.length === 0;
        // A field the note lacks: checked against it, answered or not.
        const unanswered = await env.build.define(app.id, { op: "addField", table: "notes", name: "category", type: "v.string()" });
        steps.unanswered = unanswered.ok && unanswered.plan.checks;
        const answered = await env.build.define(app.id, { op: "changeField", table: "notes", field: "category", type: "v.string()", answer: "general" });
        steps.answered = answered.ok && answered.plan.checks;
        // An answer belongs to the version it is committed with: the
        // draft starts with none of the released version's, and keeps its
        // own through a rename of its field, which this draft added.
        const renamed = await env.build.define(app.id, { op: "renameField", table: "notes", field: "category", name: "topic" });
        steps.renamed = renamed.ok && renamed.plan.checks;
        const sensitive = await env.build.define(app.id, { op: "setAccess", table: "notes", access: { read: "owner", write: "owner" }, sensitive: true });
        steps.sensitive = sensitive.ok && sensitive.plan.sensitiveTables;
        return steps;
      };`),
      says("Defined."),
    ]);
    const { id: app } = await builder.api.apps.create({ name: "Notes" });
    await release(
      builder,
      app,
      redefined(notesFiles, (definition) => ({
        ...definition,
        answers: [
          {
            table: definition.tables[0]?.id ?? "",
            field: definition.tables[0]?.fields[0]?.id ?? "",
            value: "Untitled",
          },
        ],
      }))
    );
    await calledAs(
      await builder.api.whoami(),
      app,
      { name: "notes.create", kind: "mutation" },
      { title: "Plan" }
    );
    await grant();

    await chat.ask("Give the notes a category");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    const steps = z
      .object({ released: z.boolean() })
      .loose()
      .parse(returned(result?.text));
    const events = await allEvents();
    const defined = events.filter(
      ({ action, detail }) =>
        action === "agent.call" &&
        detail.chat === chat.chat.id &&
        detail.method === "build.define"
    );
    const { answers } = await draftDefinitionOf(app);
    expect({
      ...steps,
      answers: answers.map(({ value }) => value),
      audited: defined.map(({ detail }) => [detail.op, detail.table]),
    }).toStrictEqual({
      released: true,
      unanswered: [{ table: "notes", field: "category", answer: null }],
      answered: [{ table: "notes", field: "category", answer: "general" }],
      renamed: [{ table: "notes", field: "topic", answer: "general" }],
      answers: ["general"],
      sensitive: ["notes"],
      audited: [
        ["renameField", "notes"],
        ["renameField", "notes"],
        ["addField", "notes"],
        ["changeField", "notes"],
        ["renameField", "notes"],
        ["setAccess", "notes"],
      ],
    });
  });

  it("removes what the definition holds with the definition tools, recording each by its table or alias", async () => {
    const { builder, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const [app] = (await env.apps.list()).filter(({ name }) => name === "Notes");
        const define = async (operation) => {
          const answered = await env.build.define(app.id, operation);
          return answered.ok ? "ok" : answered.problem;
        };
        const steps = [
          await define({ op: "addPermission", permission: "people" }),
          await define({ op: "removeIndex", table: "notes", name: "by_updated" }),
          await define({ op: "removeField", table: "notes", field: "body" }),
          await define({ op: "removePermission", alias: "people" }),
          await define({ op: "removeTable", table: "notes" }),
        ];
        const schema = (await env.build.files(app.id)).files["server/schema.ts"];
        return { steps, schema: schema.includes("notes") };
      };`),
      says("Removed."),
    ]);
    const { id: app } = await builder.api.apps.create({ name: "Notes" });
    await release(builder, app, notesFiles);
    await grant();

    await chat.ask("Start the data model over");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    const events = await allEvents();
    const defined = events.filter(
      ({ action, detail }) =>
        action === "agent.call" &&
        detail.chat === chat.chat.id &&
        detail.method === "build.define"
    );
    const held = await draftDefinitionOf(app);
    expect({
      ...z.object({}).loose().parse(returned(result?.text)),
      definition: [held.tables.length, held.permissions.length],
      audited: defined.map(({ detail }) => [
        detail.op,
        detail.table,
        detail.alias,
      ]),
    }).toStrictEqual({
      steps: Array.from({ length: 5 }, () => "ok"),
      definition: [0, 0],
      schema: false,
      audited: [
        ["addPermission", null, "people"],
        ["removeIndex", "notes", null],
        ["removeField", "notes", null],
        ["removePermission", null, "people"],
        ["removeTable", "notes", null],
      ],
    });
  });

  it("saves a new App's first write with the definition it gets, so its draft reads and previews whole", async () => {
    const { chat, grant } = await setUp(
      [
        codeStep(`export default async (self, env) => {
        ${findApp}
        const written = await env.build.write(app.id, ${JSON.stringify({ "src/routes/index.tsx": restyled.replace(' className="rounded-full"', "") })}, { revision: (await env.build.files(app.id)).revision });
        const draft = await env.build.files(app.id);
        return { changed: written.changed.toSorted(), files: Object.keys(draft.files).toSorted() };
      };`),
        says("Written."),
      ],
      "builder",
      true
    );
    await grant();

    await chat.ask("Build a desk");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    const files = [
      "grasp.config.ts",
      "server/_generated/api.ts",
      "server/_generated/dataModel.ts",
      "server/_generated/internal.ts",
      "server/_generated/server.ts",
      "server/schema.ts",
      "src/routes/index.tsx",
    ];
    expect(returned(result?.text)).toStrictEqual({ changed: files, files });
  });

  it("plans a definition change from the version people use, and asks again for an answer a skipped version had", async () => {
    const { builder, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const [app] = (await env.apps.list()).filter(({ name }) => name === "Notes");
        const indexed = await env.build.define(app.id, { op: "addIndex", table: "notes", name: "by_title", fields: ["title"] });
        const answered = await env.build.define(app.id, { op: "changeField", table: "notes", field: "category", type: "v.string()", answer: "general" });
        return { indexed: indexed.ok && indexed.plan.checks, answered: answered.ok && answered.plan.checks };
      };`),
      says("Indexed."),
    ]);
    const { id: app } = await builder.api.apps.create({ name: "Notes" });
    // Version 1 runs; version 2 adds a category its notes lack, answered,
    // and isn't current yet.
    await release(builder, app, notesFiles);
    await commitApp(
      builder.api.apps.files,
      app,
      definedWith(notesFiles, {
        op: "addField",
        table: "notes",
        name: "category",
        type: "v.string()",
        answer: "general",
      }),
      "Categories"
    );
    // A builder's draft over version 2: the agent changes what they
    // began.
    await draftOver(builder, app, 2);
    await grant();

    await chat.ask("Index the notes by title");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    // Released from version 1, the notes still lack the category: the
    // plan of that move checks them for it, unanswered, as version 2's
    // answer was version 2's; answered again, it is the draft's own.
    const { answers } = await draftDefinitionOf(app);
    expect({
      ...z.object({}).loose().parse(returned(result?.text)),
      answers: answers.length,
    }).toStrictEqual({
      indexed: [{ table: "notes", field: "category", answer: null }],
      answered: [{ table: "notes", field: "category", answer: "general" }],
      answers: 1,
    });
  });

  it("renames a field a version that ran had, after a rollback to one without it too, by its stable ID", async () => {
    const { builder, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const [app] = (await env.apps.list()).filter(({ name }) => name === "Notes");
        return await env.build.define(app.id, { op: "renameField", table: "notes", field: "nickname", name: "displayName" });
      };`),
      says("Renamed."),
    ]);
    const { id: app } = await builder.api.apps.create({ name: "Notes" });
    // Version 2 ran with a nickname, which people may have filled in;
    // then the App was rolled back to version 1, which has none.
    await release(builder, app, notesFiles);
    await release(
      builder,
      app,
      definedWith(notesFiles, {
        op: "addField",
        table: "notes",
        name: "nickname",
        type: "v.string().optional()",
      })
    );
    await builder.api.apps.versions.publish(app, 1);
    // A builder's draft over version 2 still: the agent changes what they
    // began.
    await draftOver(builder, app, 2);
    await grant();

    await chat.ask("Call the nickname a display name");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    // Its values, kept by the store since the rollback, follow its ID.
    expect(returned(result?.text)).toMatchObject({
      ok: true,
      plan: { refused: [] },
    });
  });

  it("keeps a draft's answer for a field whose type the version people use doesn't have yet, whatever that version answered", async () => {
    const { builder, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        const [app] = (await env.apps.list()).filter(({ name }) => name === "Notes");
        const changed = await env.build.define(app.id, { op: "changeField", table: "notes", field: "category", type: 'v.string().default("general")', answer: "general" });
        const indexed = await env.build.define(app.id, { op: "addIndex", table: "notes", name: "by_title", fields: ["title"] });
        return { changed: changed.ok, checks: indexed.ok && indexed.plan.checks };
      };`),
      says("Changed."),
    ]);
    const { id: app } = await builder.api.apps.create({ name: "Notes" });
    // The version people use: a category that may be null, answered null.
    await release(
      builder,
      app,
      definedWith(notesFiles, {
        op: "addField",
        table: "notes",
        name: "category",
        type: "v.string().nullable().default(null)",
        answer: null,
      })
    );
    await grant();

    await chat.ask("Make the category required");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    // The draft's own answer stays through a later change: the notes
    // holding null need it to fit the category that can't be null.
    const { answers } = await draftDefinitionOf(app);
    expect({
      ...z.object({}).loose().parse(returned(result?.text)),
      answers: answers.map(({ value }) => value),
    }).toStrictEqual({
      changed: true,
      checks: [{ table: "notes", field: "category", answer: "general" }],
      answers: ["general"],
    });
  });

  it("commits a definition that renames a field a version has, its ID kept", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Notes" });
    const nicknamed = definedWith(notesFiles, {
      op: "addField",
      table: "notes",
      name: "nickname",
      type: "v.string().optional()",
    });
    await release(builder, app, nicknamed);
    // Its definition.json written by hand, as an export or a builder
    // would: the field's ID kept, its name changed.
    const renamed = redefined(nicknamed, (definition) => ({
      ...definition,
      tables: definition.tables.map((table) => ({
        ...table,
        fields: table.fields.map((field) =>
          field.name === "nickname" ? { ...field, name: "displayName" } : field
        ),
      })),
    }));

    await expect(
      commitApp(builder.api.apps.files, app, renamed, "Rename")
    ).resolves.toMatchObject({ version: 2 });
  });

  it("keeps no change that leaves a file as the base has it", async () => {
    const ledger = `const [app] = (await env.apps.list()).filter(({ name }) => name === "Ledger");`;
    const { existing, chat, grant } = await setUp([
      codeStep(`export default async (self, env) => {
        ${ledger}
        const steps = [];
        steps.push((await env.build.write(app.id, { "notes.md": "new", "gone.md": null }, { revision: (await env.build.files(app.id)).revision })).changed);
        // Back as the base has it, and a missing file deleted again.
        steps.push((await env.build.write(app.id, { "notes.md": null, "AGENTS.md": "# Ledger\\n", "gone.md": null }, { revision: (await env.build.files(app.id)).revision })).changed);
        return steps;
      };`),
      says("Nothing changed."),
    ]);
    await grant();

    await chat.ask("Try some notes");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual([["notes.md"], []]);
    await expect(readDraft(env, existing)).resolves.toMatchObject({
      changes: {},
      revision: 2,
    });
    // Its builders see it as changing nothing.
    await expect(draftSummary(env, existing)).resolves.toMatchObject({
      changed: [],
      revision: 2,
    });
  });

  it("builds for whoever builds, as them, with no permission of its own, and never past what they may do", async () => {
    const resultOf = async (role: "admin" | "user", granted: boolean) => {
      const { chat, grant } = await setUp(
        (existing) => [codeStep(writeAndCall(existing)), says("Done.")],
        role
      );
      if (granted) {
        await grant();
      }
      await chat.ask("Build something");
      const [result] = await codeResults(chat.stub, chat.chat.id);
      return returned(result?.text);
    };
    const notFound = appErrors.create("app.not_found").message;

    // An admin in a new deployment, whose agent was granted nothing: they
    // build every App, so the agent writes it, as them.
    await expect(resultOf("admin", false)).resolves.toStrictEqual({
      write: ["notes.md"],
      call: notFound,
    });
    // Every permission the agent could hold reaches no further than its
    // person: a member who doesn't build it writes nothing of it.
    await expect(resultOf("user", true)).resolves.toStrictEqual({
      write: notFound,
      call: notFound,
    });
  });

  it("changes only the Apps its person builds", async () => {
    const other = await signedInApi(idp, "builder");
    const { id: shared } = await other.api.apps.create({ name: "Shared" });
    await published(shared);
    const { id: unshared } = await other.api.apps.create({ name: "Other" });
    await published(unshared);
    const { person, chat, grant } = await setUp([
      codeStep(
        tryEach({
          shared: `await env.build.write(${JSON.stringify(shared)}, { "a.md": "a" }, { revision: (await env.build.files(${JSON.stringify(shared)})).revision })`,
          unshared: `await env.build.write(${JSON.stringify(unshared)}, { "a.md": "a" }, { revision: (await env.build.files(${JSON.stringify(unshared)})).revision })`,
          sharedCall: `await env.build.call(${JSON.stringify(shared)}, "count")`,
          unsharedCall: `await env.build.call(${JSON.stringify(unshared)}, "count")`,
        })
      ),
      says("No."),
    ]);
    await grant();
    // They use the shared App's pages, but don't build it.
    await other.api.apps.members.add(shared, {
      type: "person",
      id: person.userId,
      role: "user",
    });

    await chat.ask("Change the other Apps");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      shared: roleErrors.create("role.forbidden").message,
      unshared: appErrors.create("app.not_found").message,
      sharedCall: roleErrors.create("role.forbidden").message,
      unsharedCall: appErrors.create("app.not_found").message,
    });
  });
});
