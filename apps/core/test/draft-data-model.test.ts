import { declaredPermission } from "@grasp-os/runtime/host";
import { appErrors } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import { roleErrors } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { loadRelease } from "../src/app-releases.ts";
import { release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import {
  jobEventsDeclared,
  jobEventsContract,
  jobWaitingOf,
  requestsApp,
} from "./json-workflow-apps.ts";
import { notesFiles } from "./notes-client-app.ts";
import { calledAs } from "./sealed-apps.ts";
import { signedInApi, unique } from "./sign-in.ts";
import { publishOverRpc } from "./workflow-publishing.ts";

// The data model of a chat's draft of an App, changed by its person from
// the App's workspace (`chats.dataModel`, `chats.defineDraft`), with the
// definition's own operations as the chat's agent's tools make them
// (agent-builds.ts, `defineInDraft`). These tests start from the ways it
// can fail: someone who doesn't build the App, or builds it but changes
// another person's chat, changes its definition; an archived App is
// changed; a preview saves what it only shows; a change the definition
// can't take saves part of itself; a change of the person's goes
// unaudited; and a change hides what it does to the records the App
// holds, or drops them.

const idp = mockIdp();

/** The code of the error `promise` fails with, or `ok`. */
const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : String(error);
  }
};

/** A builder's Notes App, released and published, with one of their notes. */
const notesWithANote = async () => {
  const builder = await signedInApi(idp, "builder");
  const { id: app } = await builder.api.apps.create({ name: "Notes" });
  await release(builder, app, notesFiles);
  await calledAs(
    await builder.api.whoami(),
    app,
    { name: "notes.create", kind: "mutation" },
    { title: "Plan" }
  );
  return { builder, app };
};

describe(
  "a draft's data model, changed by its person",
  { timeout: 120_000 },
  () => {
    it("adds a table with a field of each kind, saved into the draft with the code generated from it, and audited as the person's", async () => {
      const { builder, app } = await notesWithANote();
      const { apps, drafts } = builder.api;
      const kinds = {
        title: "v.string().trim().max(200)",
        email: "v.string().email().optional()",
        amount: "v.number().integer().min(0)",
        done: "v.boolean().default(false)",
        due: "v.timestamp().optional()",
        status: 'v.enum(["open", "done"])',
        note: 'v.id("notes", { onDelete: "cascade" }).optional()',
        owner: "v.person()",
        file: "v.file().optional()",
        price: "v.money().optional()",
        tags: "v.array(v.string())",
        score: "v.number().nullable().default(0)",
      };

      const added = await apps.define(app, {
        op: "addTable",
        name: "tasks",
        fields: kinds,
      });
      const model = await apps.dataModel(app);
      const files = await drafts.files({ kind: "app", id: app });
      const events = await allEvents();
      const audited = events.filter(
        ({ action, target }) => action === "draft.saved" && target?.id === app
      );

      const tasks = model.model.tables.find(({ name }) => name === "tasks");
      expect({
        ok: added.ok,
        fields: tasks?.fields.map(({ name, type, required, code }) => ({
          name,
          type,
          required,
          code,
        })),
        // What a change of its options keeps: null, and its default.
        kept: tasks?.fields.flatMap(({ name, nullable, defaultCode }) =>
          nullable || defaultCode !== null
            ? [{ name, nullable, defaultCode }]
            : []
        ),
        added: model.plan.addedTables,
        schema: files["server/schema.ts"]?.includes("tasks: defineTable"),
        audited: audited.map(({ actor, detail }) => ({
          actor: actor.type,
          op: detail.op,
          table: detail.table,
        })),
      }).toStrictEqual({
        ok: true,
        fields: [
          {
            name: "title",
            type: { kind: "text", trim: true, min: null, max: 200 },
            required: true,
            code: "v.string().trim().max(200)",
          },
          {
            name: "email",
            type: { kind: "email", trim: false, min: null, max: null },
            required: false,
            code: "v.string().email()",
          },
          {
            name: "amount",
            type: { kind: "number", integer: true, min: 0, max: null },
            required: true,
            code: "v.number().integer().min(0)",
          },
          {
            name: "done",
            type: { kind: "boolean", default: false },
            required: true,
            code: "v.boolean()",
          },
          {
            name: "due",
            type: { kind: "date" },
            required: false,
            code: "v.timestamp()",
          },
          {
            name: "status",
            type: { kind: "choice", values: ["open", "done"] },
            required: true,
            code: 'v.enum(["open", "done"])',
          },
          {
            name: "note",
            type: { kind: "link", table: "notes", cascade: true },
            required: false,
            code: 'v.id("notes", {\n  onDelete: "cascade"\n})',
          },
          {
            name: "owner",
            type: { kind: "person" },
            required: true,
            code: "v.person()",
          },
          {
            name: "file",
            type: { kind: "file" },
            required: false,
            code: "v.file()",
          },
          {
            name: "price",
            type: { kind: "money" },
            required: false,
            code: "v.money()",
          },
          {
            name: "tags",
            type: { kind: "other" },
            required: true,
            code: "v.array(v.string())",
          },
          {
            name: "score",
            type: { kind: "number", integer: false, min: null, max: null },
            required: true,
            code: "v.number().nullable()",
          },
        ],
        kept: [
          { name: "done", nullable: false, defaultCode: ".default(false)" },
          { name: "score", nullable: true, defaultCode: ".default(0)" },
        ],
        added: ["tasks"],
        schema: true,
        audited: [{ actor: "person", op: "addTable", table: "tasks" }],
      });
    });

    it("previews a change without saving it, and asks what the records it would check get", async () => {
      const { builder, app } = await notesWithANote();
      const { apps, drafts } = builder.api;
      const operation = {
        op: "addField",
        table: "notes",
        name: "category",
        type: "v.string()",
      };

      const previewed = await apps.define(app, operation, true);
      const unchanged = await apps.dataModel(app);
      const answered = await apps.define(app, {
        ...operation,
        answer: "general",
      });
      const written = [await drafts.get({ kind: "app", id: app })];

      expect({
        previewed: previewed.ok && previewed.plan.checks,
        previewedFields:
          previewed.ok &&
          previewed.model.tables[0]?.fields.map(({ name }) => name),
        unchangedFields: unchanged.model.tables[0]?.fields.map(
          ({ name }) => name
        ),
        answered: answered.ok && answered.plan.checks,
        revisions: written.map(({ revision }) => revision),
      }).toStrictEqual({
        // The note the App holds lacks the category: checked, unanswered.
        previewed: [{ table: "notes", field: "category", answer: null }],
        previewedFields: ["title", "body", "category"],
        unchangedFields: ["title", "body"],
        answered: [{ table: "notes", field: "category", answer: "general" }],
        // Only the change made was saved.
        revisions: [1],
      });
    });

    it("removes a field and a table, keeping their records, and says what it can't take without saving anything", async () => {
      const { builder, app } = await notesWithANote();
      const { apps, drafts } = builder.api;

      const fieldless = await apps.define(app, {
        op: "removeField",
        table: "notes",
        field: "body",
      });
      const refused = await apps.define(app, {
        op: "removeTable",
        table: "nope",
      });
      const tableless = await apps.define(app, {
        op: "removeTable",
        table: "notes",
      });
      const invalid = await outcome(apps.define(app, { op: "dropEverything" }));
      const written = [await drafts.get({ kind: "app", id: app })];

      expect({
        kept: fieldless.ok && fieldless.plan.keptFields,
        refused,
        keptTables: tableless.ok && tableless.plan.keptTables,
        invalid,
        revisions: written.map(({ revision }) => revision),
      }).toStrictEqual({
        kept: [{ table: "notes", field: "body" }],
        refused: {
          ok: false,
          problem: "The App has no table `nope`. Its tables: `notes`.",
        },
        keptTables: ["notes"],
        invalid: "app.invalid",
        revisions: [2],
      });
    });

    it("makes a few operations as one change, all or none, and says what that change alone does", async () => {
      const { builder, app } = await notesWithANote();
      const { apps, drafts } = builder.api;
      await apps.define(app, {
        op: "removeField",
        table: "notes",
        field: "body",
      });
      // A field of the draft's own: one a released version has keeps its name.
      await apps.define(app, {
        op: "addField",
        table: "notes",
        name: "category",
        type: "v.string().optional()",
      });

      const renamedAndRetyped = await apps.define(app, [
        { op: "renameField", table: "notes", field: "category", name: "rank" },
        {
          op: "changeField",
          table: "notes",
          field: "rank",
          type: "v.number().optional()",
        },
      ]);
      const halfRefused = await apps.define(app, [
        { op: "renameField", table: "notes", field: "rank", name: "topic" },
        { op: "removeTable", table: "nope" },
      ]);
      const model = await apps.dataModel(app);
      const written = [await drafts.get({ kind: "app", id: app })];

      expect({
        // The draft's removal of body stays in the plan, never in this change's.
        planKept: renamedAndRetyped.ok && renamedAndRetyped.plan.keptFields,
        changeKept: renamedAndRetyped.ok && renamedAndRetyped.change.keptFields,
        halfRefused: halfRefused.ok,
        // What reads the table's index, from the App's code.
        uses: model.uses,
        fields: model.model.tables[0]?.fields.map(({ name, type }) => ({
          name,
          kind: type.kind,
        })),
        revisions: written.map(({ revision }) => revision),
      }).toStrictEqual({
        planKept: [{ table: "notes", field: "body" }],
        changeKept: [],
        halfRefused: false,
        uses: [
          {
            table: "notes",
            index: "by_updated",
            query: "notes.list",
            pages: ["/"],
          },
        ],
        fields: [
          { name: "title", kind: "text" },
          { name: "rank", kind: "number" },
        ],
        // The removal, the field added, and the rename and retype as one.
        revisions: [3],
      });
    });

    it("is refused to anyone who doesn't build the App, and for an archived App, and shared by every builder of it", async () => {
      const { builder, app } = await notesWithANote();
      const [user, otherBuilder] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "builder"),
      ]);
      await builder.api.apps.members.add(app, {
        type: "person",
        id: user.userId,
        role: "user",
      });
      await builder.api.apps.members.add(app, {
        type: "person",
        id: otherBuilder.userId,
        role: "builder",
      });
      const operation = { op: "addTable", name: "sneaked" };

      // Someone who only uses the App has no chat of it to build in: the
      // builder's is refused to them all the same, for their role first.
      const user_ = await outcome(user.api.apps.define(app, operation));
      const userRead = await outcome(user.api.apps.dataModel(app));
      // Another builder of the App: the same draft, theirs too.
      const othersChat = await outcome(
        otherBuilder.api.apps.define(app, operation)
      );
      const othersRead = await outcome(otherBuilder.api.apps.dataModel(app));
      await builder.api.apps.archive(app);
      const archived = await outcome(builder.api.apps.define(app, operation));
      const { revision } = await builder.api.drafts.get({
        kind: "app",
        id: app,
      });

      expect({
        user: user_,
        userRead,
        othersChat,
        othersRead,
        archived,
        revision,
      }).toStrictEqual({
        user: roleErrors.create("role.forbidden").code,
        userRead: roleErrors.create("role.forbidden").code,
        othersChat: "ok",
        othersRead: "ok",
        archived: appErrors.create("app.archived").code,
        // The other builder's change, the one written.
        revision: 1,
      });
    });
  }
);

describe("a workflow bound from a draft", { timeout: 120_000 }, () => {
  it("declares its live version's events and listen tasks in the draft, for an alias the App declares and a person with a role in the workflow, so it binds once that draft is published", async () => {
    const [admin, builder, otherBuilder] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
    ]);
    const contract = await jobEventsContract(admin);
    const flow = await builder.api.workflowResources.create(
      `bound-${unique()}`
    );
    await publishOverRpc(builder.api, flow.id, jobWaitingOf(contract));
    // Another workflow, live at a version that waits for another event
    // too, in a task of its own.
    const later = await builder.api.workflowResources.create(
      `later-${unique()}`
    );
    await publishOverRpc(
      builder.api,
      later.id,
      jobWaitingOf(contract, { more: ["laterEvents"] })
    );
    const { id: app } = await builder.api.apps.create({ name: "Requests" });
    const api = builder.api.workflowResources;
    await api.bindToApp(flow.id, { app, alias: "review" });
    await release(builder, app, requestsApp("review", jobEventsDeclared));
    // Another builder of the App, with no role in the workflow.
    await builder.api.apps.members.add(app, {
      type: "person",
      id: otherBuilder.userId,
      role: "builder",
    });
    const bindSecond = async () =>
      await outcome(api.bindToApp(later.id, { app, alias: "review" }));
    const bindInDraft = (alias: string) => ({
      op: "bindWorkflow",
      alias,
      workflow: later.id,
    });

    // The App's current version declares the first workflow's events.
    const beforeDraft = await bindSecond();
    const undeclared = await builder.api.apps.define(app, bindInDraft("ghost"));
    const noRole = await outcome(
      otherBuilder.api.apps.define(app, bindInDraft("review"))
    );
    // What the version has is read by core, never taken from the caller.
    const forged = await outcome(
      builder.api.apps.define(app, {
        op: "setWorkflowContract",
        alias: "review",
        contract: { events: {}, listens: {}, decisions: {} },
      })
    );
    const declared = await builder.api.apps.define(app, bindInDraft("review"));
    // Still the live version's declaration, until the draft is published.
    const draftOnly = await bindSecond();
    const { revision } = await builder.api.drafts.get({ kind: "app", id: app });
    const { version } = await builder.api.drafts.publish(
      { kind: "app", id: app },
      revision
    );
    // What the release of the draft's version declares, as its host reads it.
    const proposed = await loadRelease(env, appIdSchema.parse(app), version);
    const sealed = declaredPermission(proposed.app, "review", "workflows");
    const events = await allEvents();
    const audited = events
      .filter(
        ({ action, target, detail }) =>
          action === "draft.saved" &&
          target?.id === app &&
          detail.op === "bindWorkflow"
      )
      .map(({ detail }) => ({
        alias: detail.alias,
        workflow: detail.workflow,
      }));

    expect({
      beforeDraft,
      undeclared,
      noRole,
      forged,
      declared: declared.ok,
      sealed: { events: sealed?.events, listens: sealed?.listens },
      audited,
      draftOnly,
      afterCurrent: await bindSecond(),
    }).toStrictEqual({
      beforeDraft: "workflow.app_binding_contract_changed",
      undeclared: {
        ok: false,
        problem:
          "The App declares no workflow `ghost`: add it with `addPermission` first.",
      },
      noRole: "workflow.resource_unavailable",
      forged: "app.invalid",
      declared: true,
      // The live version's events and listen tasks, as it has them.
      sealed: {
        events: {
          jobEvents: jobEventsDeclared.events.jobEvents,
          laterEvents: jobEventsDeclared.events.jobEvents,
        },
        listens: { job: ["jobEvents"], laterEvents: ["laterEvents"] },
      },
      // The workflow and version the declaration was read from.
      audited: [{ alias: "review", workflow: later.id }],
      draftOnly: "workflow.app_binding_contract_changed",
      afterCurrent: "ok",
    });
  });
});
