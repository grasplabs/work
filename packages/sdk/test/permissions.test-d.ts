// Compile-time guarantees of permissions (spec 12): a connection names a
// generated contract of the release (the SDK's connector catalog,
// `connector-catalog.gen.ts`) and some of its actions, and
// `ctx.connections.<alias>.call(action, args)` then infers that action's
// arguments and answer from the contract alone, without a cast or a
// generic argument; the platform's functions are typed by what
// `permission.grasp()` declares of them; `ctx.ai`, `ctx.brain`,
// `ctx.grasp` and `ctx.guests` are there only for an action of an App
// that declares them. This file is type-checked by
// `vp check` and never run: every `@ts-expect-error` below must stay an
// error.
import { expectTypeOf } from "vite-plus/test";

import { defineApp, permission } from "../src/index.ts";
import type { ConnectorAction, ConnectorContract } from "../src/index.ts";
import { serverModule } from "../src/server.ts";
import type { ActionCtx } from "../src/server.ts";
import type { JsonValue } from "../src/value-descriptor.ts";
import { defineSchema, defineTable, v } from "../src/values.ts";

const mail = permission.connection("mail", {
  contract: "microsoft-365.mail@1",
  actions: ["send", "list"],
});

const { action } = serverModule(
  defineSchema({ notes: defineTable({ title: v.string() }) }),
  defineApp({ name: "Mail", permissions: { connections: [mail] } })
);
const gmail = permission.connection("gmail", {
  contract: "google-workspace.mail@1",
  actions: ["send", "labels"],
});

// The catalog names the release's contracts and their actions.
expectTypeOf<"microsoft-365.mail@1">().toExtend<ConnectorContract>();
expectTypeOf<"google-workspace.files@1">().toExtend<ConnectorContract>();
expectTypeOf<"grasp.mail@1">().not.toExtend<ConnectorContract>();
expectTypeOf<ConnectorAction<"microsoft-365.mail@1">>().toEqualTypeOf<
  | "categorise"
  | "createDraft"
  | "createReplyDraft"
  | "flag"
  | "get"
  | "list"
  | "move"
  | "readAttachment"
  | "send"
  | "thread"
>();

declare const ctx: ActionCtx<typeof mail | typeof gmail>;

// Arguments as the contract takes them: optional fields may be left out.
const sent = await ctx.connections.mail.call("send", {
  mailbox: "team@acme.test",
  subject: "Hello",
  body: "Hi.",
  to: ["ada@acme.test"],
});
// The answer as the contract gives it, with no narrowing first.
expectTypeOf(sent).toEqualTypeOf<{ mailbox: string; sent: true }>();
await ctx.connections.mail.call("send", {
  mailbox: "team@acme.test",
  subject: "Hello",
  body: "<p>Hi.</p>",
  bodyType: "html",
  to: ["ada@acme.test"],
  cc: ["grace@acme.test"],
});

// Each action has its own types, and so does each contract.
const listed = await ctx.connections.mail.call("list", {
  mailbox: "team@acme.test",
  top: 10,
});
expectTypeOf(listed.nextPage).toEqualTypeOf<string | null>();
expectTypeOf(listed.messages[0]?.subject).toEqualTypeOf<
  string | null | undefined
>();
const gmailSent = await ctx.connections.gmail.call("send", {
  mailbox: "me",
  subject: "Hello",
  body: "Hi.",
  to: ["ada@acme.test"],
});
expectTypeOf(gmailSent.threadId).toEqualTypeOf<string | null>();
expectTypeOf(
  ctx.connections.gmail.call("labels", { mailbox: "me" })
).resolves.toEqualTypeOf<{
  labels: { id: string; name: string; type: string | null }[];
  mailbox: string;
}>();

// The same through an action of an App that declares it: its handler's
// answer is typed by it.
action({
  args: { to: v.string().email() },
  returns: v.string(),
  handler: async (context, args) => {
    const answer = await context.connections.mail.call("send", {
      mailbox: "team@acme.test",
      subject: "Hello",
      body: "Hi.",
      to: [args.to],
    });
    return answer.mailbox;
  },
});

// Refused: a contract the release doesn't generate.
// @ts-expect-error -- not a generated contract
permission.connection("x", { contract: "grasp.mail@1", actions: ["send"] });
// Refused: an action its contract doesn't have, though another one does.
permission.connection("other", {
  contract: "microsoft-365.mail@1",
  // @ts-expect-error -- Google's mail has labels; Microsoft's hasn't
  actions: ["labels"],
});
permission.connection("other", {
  contract: "microsoft-365.calendar@1",
  // @ts-expect-error -- `send` is mail's, not the calendar's
  actions: ["send"],
});

// Refused: an action the declaration doesn't list, though its contract has it.
// @ts-expect-error -- `move` isn't declared
await ctx.connections.mail.call("move", {});

await ctx.connections.mail.call("send", {
  mailbox: "team@acme.test",
  subject: "Hello",
  body: "Hi.",
  // @ts-expect-error -- recipients are a list
  to: "ada@acme.test",
});
// @ts-expect-error -- `to` is required
await ctx.connections.mail.call("send", {
  mailbox: "team@acme.test",
  subject: "Hello",
  body: "Hi.",
});
await ctx.connections.mail.call("send", {
  mailbox: "team@acme.test",
  subject: "Hello",
  body: "Hi.",
  to: ["ada@acme.test"],
  // @ts-expect-error -- not a body type the contract has
  bodyType: "markdown",
});
await ctx.connections.mail.call("send", {
  mailbox: "team@acme.test",
  subject: "Hello",
  body: "Hi.",
  to: ["ada@acme.test"],
  // @ts-expect-error -- the contract has no such argument
  priority: "high",
});
// @ts-expect-error -- Microsoft's send answers no thread
expectTypeOf(sent.threadId).toBeString();
// The answer isn't any value: it can't be used as one it isn't.
// @ts-expect-error -- `sent` is `true`, not a string
expectTypeOf(sent.sent).toBeString();

// An action known only as one of several: its arguments must fit
// whichever it is, so arguments that fit only `list` are refused.
declare const either: "send" | "list";
// @ts-expect-error -- fits `list`, but not `send`
await ctx.connections.mail.call(either, { mailbox: "team@acme.test" });
// Narrowed, each branch is typed by its own action, and so is its answer.
const answer =
  either === "send"
    ? await ctx.connections.mail.call(either, {
        mailbox: "team@acme.test",
        subject: "Hello",
        body: "Hi.",
        to: ["ada@acme.test"],
      })
    : await ctx.connections.mail.call(either, { mailbox: "team@acme.test" });
expectTypeOf(answer).toExtend<
  { mailbox: string; sent: true } | { nextPage: string | null }
>();
// A literal action still infers that action alone, answer included.
expectTypeOf(
  ctx.connections.mail.call("list", { mailbox: "team@acme.test" })
).resolves.toHaveProperty("messages");
expectTypeOf(
  ctx.connections.mail.call("list", { mailbox: "team@acme.test" })
).resolves.not.toHaveProperty("sent");

// A Composio toolkit's contract (`composio.<toolkit>@1`): its tools change
// without a release, so it isn't in the catalog and its calls are untyped
// JSON, checked by the host against the contract its binding pinned.
const crm = permission.connection("crm", {
  contract: "composio.hubspot@1",
  actions: ["HUBSPOT_LIST_CONTACTS"],
});
expectTypeOf<"composio.hubspot@1">().toExtend<ConnectorContract>();
expectTypeOf<ConnectorAction<"composio.hubspot@1">>().toEqualTypeOf<string>();
declare const crmCtx: ActionCtx<typeof crm>;
const contacts = await crmCtx.connections.crm.call("HUBSPOT_LIST_CONTACTS", {
  limit: 5,
});
expectTypeOf(contacts).toEqualTypeOf<JsonValue>();
// @ts-expect-error -- arguments are a JSON object
await crmCtx.connections.crm.call("HUBSPOT_LIST_CONTACTS", "all");
// @ts-expect-error -- only the actions it declares
await crmCtx.connections.crm.call("HUBSPOT_CREATE_CONTACT", {});
permission.connection("old", {
  // @ts-expect-error -- Composio contracts are generated at version 1 only
  contract: "composio.hubspot@2",
  actions: ["X"],
});
permission.connection("lookalike", {
  // @ts-expect-error -- not a Composio contract: a family of no native connector
  contract: "hubspot.crm@1",
  actions: ["X"],
});

// Apps don't call each other: there's no declaration of another App's
// functions.
expectTypeOf(permission).not.toHaveProperty("app");

// The platform's own read-only functions, under `grasp`.
const grasp = permission.grasp();
declare const graspCtx: ActionCtx<typeof grasp>;
const runs = await graspCtx.grasp.call("statistics.read", {
  measure: "platform.workflow_runs",
  days: 30,
  apps: ["app_1"],
  groupBy: ["app"],
});
expectTypeOf(runs.groups[0]?.count).toEqualTypeOf<number | undefined>();
await graspCtx.grasp.call("statistics.read", {
  // @ts-expect-error -- only the measures the platform publishes
  measure: "invoices_booked",
  days: 30,
  apps: ["app_1"],
});

// AI: text, or the value of the `output` a request asks for.
const ai = permission.ai({ maxOutputTokens: 500 });
declare const aiCtx: ActionCtx<typeof ai>;
expectTypeOf(
  aiCtx.ai.generate({ prompt: "Hi" })
).resolves.toEqualTypeOf<string>();
expectTypeOf(
  aiCtx.ai.generate({
    prompt: "Tag it",
    output: v.object({ tags: v.array(v.string()) }),
  })
).resolves.toEqualTypeOf<{ tags: string[] }>();

// The Brain and guest chats: the operations each declares, and no other.
const brain = permission.brain({
  operations: ["search"],
  collections: ["handbook"],
});
const guests = permission.guests({ operations: ["list", "revoke"] });
declare const brainCtx: ActionCtx<typeof brain | typeof guests>;
expectTypeOf(brainCtx.brain.search({ text: "leave" })).resolves.toEqualTypeOf<
  { title: string; excerpt: string }[]
>();
// Only the operations each declares.
expectTypeOf(brainCtx.brain).not.toHaveProperty("read");
await brainCtx.guests.revoke("chat");
expectTypeOf(brainCtx.guests).not.toHaveProperty("invite");

// An action that lists none of them reaches none of them.
declare const bare: ActionCtx;
expectTypeOf(bare).not.toHaveProperty("ai");
expectTypeOf(bare).not.toHaveProperty("brain");
expectTypeOf(bare).not.toHaveProperty("guests");
expectTypeOf(bare.connections).not.toHaveProperty("mail");
expectTypeOf(bare).not.toHaveProperty("grasp");
