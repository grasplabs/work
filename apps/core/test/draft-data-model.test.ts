import { appErrors } from "@grasp-os/shared/apps";
import { chatIdSchema } from "@grasp-os/shared/ids";
import type { ChatId } from "@grasp-os/shared/ids";
import { roleErrors } from "@grasp-os/shared/roles";
import { describe, expect, it } from "vite-plus/test";

import { published, release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { notesFiles } from "./notes-client-app.ts";
import { calledAs } from "./sealed-apps.ts";
import { signedInApi } from "./sign-in.ts";

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

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** `person`'s chat of App `app`, its own (`chats.forApp`). */
const appChat = async (person: Person, app: string): Promise<ChatId> => {
  const chat = await person.api.chats.forApp(app);
  return chatIdSchema.parse(chat.id);
};

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
  await published(app);
  await release(builder, app, notesFiles);
  await calledAs(
    await builder.api.whoami(),
    app,
    { name: "notes.create", kind: "mutation" },
    { title: "Plan" }
  );
  return { builder, app, chatId: await appChat(builder, app) };
};

describe(
  "a draft's data model, changed by its person",
  { timeout: 120_000 },
  () => {
    it("adds a table with a field of each kind, saved into the draft with the code generated from it, and audited as the person's", async () => {
      const { builder, app, chatId } = await notesWithANote();
      const { chats } = builder.api;
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
      };

      const added = await chats.defineDraft(chatId, app, {
        op: "addTable",
        name: "tasks",
        fields: kinds,
      });
      const model = await chats.dataModel(chatId, app);
      const files = await chats.draftFiles(chatId, app);
      const events = await allEvents();
      const audited = events.filter(
        ({ action, target }) =>
          action === "chat.draft_defined" && target?.id === chatId
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
        ],
        added: ["tasks"],
        schema: true,
        audited: [{ actor: "person", op: "addTable", table: "tasks" }],
      });
    });

    it("previews a change without saving it, and asks what the records it would check get", async () => {
      const { builder, app, chatId } = await notesWithANote();
      const { chats } = builder.api;
      const operation = {
        op: "addField",
        table: "notes",
        name: "category",
        type: "v.string()",
      };

      const previewed = await chats.defineDraft(chatId, app, operation, true);
      const unchanged = await chats.dataModel(chatId, app);
      const answered = await chats.defineDraft(chatId, app, {
        ...operation,
        answer: "general",
      });
      const drafts = await chats.drafts(chatId);

      expect({
        previewed: previewed.ok && previewed.plan.checks,
        previewedFields:
          previewed.ok &&
          previewed.model.tables[0]?.fields.map(({ name }) => name),
        unchangedFields: unchanged.model.tables[0]?.fields.map(
          ({ name }) => name
        ),
        answered: answered.ok && answered.plan.checks,
        revisions: drafts.map(({ revision }) => revision),
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
      const { builder, app, chatId } = await notesWithANote();
      const { chats } = builder.api;

      const fieldless = await chats.defineDraft(chatId, app, {
        op: "removeField",
        table: "notes",
        field: "body",
      });
      const refused = await chats.defineDraft(chatId, app, {
        op: "removeTable",
        table: "nope",
      });
      const tableless = await chats.defineDraft(chatId, app, {
        op: "removeTable",
        table: "notes",
      });
      const invalid = await outcome(
        chats.defineDraft(chatId, app, { op: "dropEverything" })
      );
      const drafts = await chats.drafts(chatId);

      expect({
        kept: fieldless.ok && fieldless.plan.keptFields,
        refused,
        keptTables: tableless.ok && tableless.plan.keptTables,
        invalid,
        revisions: drafts.map(({ revision }) => revision),
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

    it("is refused to anyone who doesn't build the App, in another person's chat, and for an archived App", async () => {
      const { builder, app, chatId } = await notesWithANote();
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
      const user_ = await outcome(
        user.api.chats.defineDraft(chatId, app, operation)
      );
      const userRead = await outcome(user.api.chats.dataModel(chatId, app));
      // Another builder of the App, in the first builder's chat.
      const othersChat = await outcome(
        otherBuilder.api.chats.defineDraft(chatId, app, operation)
      );
      const othersRead = await outcome(
        otherBuilder.api.chats.dataModel(chatId, app)
      );
      await builder.api.apps.archive(app);
      const archived = await outcome(
        builder.api.chats.defineDraft(chatId, app, operation)
      );
      const drafts = await builder.api.chats.drafts(chatId);

      expect({
        user: user_,
        userRead,
        othersChat,
        othersRead,
        archived,
        drafts: drafts.map(({ revision }) => revision),
      }).toStrictEqual({
        user: roleErrors.create("role.forbidden").code,
        userRead: roleErrors.create("role.forbidden").code,
        othersChat: "agent.chat_not_found",
        othersRead: "agent.chat_not_found",
        archived: appErrors.create("app.archived").code,
        drafts: [],
      });
    });
  }
);
