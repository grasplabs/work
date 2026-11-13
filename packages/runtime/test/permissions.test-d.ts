// Compile-time guarantees of permissions (spec 12): a connection names a
// generated contract of the release (the SDK's connector catalog,
// `connector-catalog.gen.ts`) and some of its actions, and
// each declared action is then a member, `ctx.connections.<alias>.<action>(args)`,
// whose arguments and answer come from the contract alone, without a cast
// or a generic argument, and an undeclared one isn't a member; the
// platform's functions are members of their namespace
// (`ctx.grasp.statistics.read(args)`), typed by what `permission.grasp()`
// declares of them; `ctx.ai`, `ctx.brain`,
// `ctx.grasp` and `ctx.guests` are there only for an action of an App
// that declares them. This file is type-checked by
// `vp check` and never run: every `@ts-expect-error` below must stay an
// error.
import { expectTypeOf } from "vite-plus/test";

import { defineApp, permission } from "../src/index.ts";
import type {
  BrainPack,
  BrainSkillsSelected,
  BrainSkillText,
  ConnectorAction,
  ConnectorContract,
} from "../src/index.ts";
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
const sent = await ctx.connections.mail.send({
  mailbox: "team@acme.test",
  subject: "Hello",
  body: "Hi.",
  to: ["ada@acme.test"],
});
// The answer as the contract gives it, with no narrowing first.
expectTypeOf(sent).toEqualTypeOf<{ mailbox: string; sent: true }>();
await ctx.connections.mail.send({
  mailbox: "team@acme.test",
  subject: "Hello",
  body: "<p>Hi.</p>",
  bodyType: "html",
  to: ["ada@acme.test"],
  cc: ["grace@acme.test"],
});

// Each action has its own types, and so does each contract.
const listed = await ctx.connections.mail.list({
  mailbox: "team@acme.test",
  top: 10,
});
expectTypeOf(listed.nextPage).toEqualTypeOf<string | null>();
expectTypeOf(listed.messages[0]?.subject).toEqualTypeOf<
  string | null | undefined
>();
const gmailSent = await ctx.connections.gmail.send({
  mailbox: "me",
  subject: "Hello",
  body: "Hi.",
  to: ["ada@acme.test"],
});
expectTypeOf(gmailSent.threadId).toEqualTypeOf<string | null>();
expectTypeOf(
  ctx.connections.gmail.labels({ mailbox: "me" })
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
    const answer = await context.connections.mail.send({
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

// Refused: an action the declaration doesn't list, though its contract has
// it, isn't a member.
expectTypeOf(ctx.connections.mail).not.toHaveProperty("move");
// There's no `call`: each action is its own member.
expectTypeOf(ctx.connections.mail).not.toHaveProperty("call");

await ctx.connections.mail.send({
  mailbox: "team@acme.test",
  subject: "Hello",
  body: "Hi.",
  // @ts-expect-error -- recipients are a list
  to: "ada@acme.test",
});
// @ts-expect-error -- `to` is required
await ctx.connections.mail.send({
  mailbox: "team@acme.test",
  subject: "Hello",
  body: "Hi.",
});
await ctx.connections.mail.send({
  mailbox: "team@acme.test",
  subject: "Hello",
  body: "Hi.",
  to: ["ada@acme.test"],
  // @ts-expect-error -- not a body type the contract has
  bodyType: "markdown",
});
await ctx.connections.mail.send({
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
const contacts = await crmCtx.connections.crm.HUBSPOT_LIST_CONTACTS({
  limit: 5,
});
expectTypeOf(contacts).toEqualTypeOf<JsonValue>();
// @ts-expect-error -- arguments are a JSON object
await crmCtx.connections.crm.HUBSPOT_LIST_CONTACTS("all");
// Only the actions it declares.
expectTypeOf(crmCtx.connections.crm).not.toHaveProperty(
  "HUBSPOT_CREATE_CONTACT"
);

// An action name with `-` is a camel-case member; the host still gets
// the name as declared.
const tools = permission.connection("tools", {
  contract: "composio.tools@1",
  actions: ["send-mail", "get-v2"],
});
declare const toolsCtx: ActionCtx<typeof tools>;
expectTypeOf(
  toolsCtx.connections.tools.sendMail({})
).resolves.toEqualTypeOf<JsonValue>();
expectTypeOf(toolsCtx.connections.tools.getV2).toBeFunction();
expectTypeOf(toolsCtx.connections.tools).not.toHaveProperty("send-mail");

// An HTTP connection is `fetch` alone, with only the methods its declared
// actions allow: without `send`, no POST; without `get`, a method.
const billing = permission.connection("billing", {
  contract: "http.request@1",
  actions: ["get"],
});
const webhook = permission.connection("webhook", {
  contract: "http.request@1",
  actions: ["send"],
});
declare const httpCtx: ActionCtx<typeof billing | typeof webhook>;
expectTypeOf(
  httpCtx.connections.billing.fetch("/v1/invoices")
).resolves.toEqualTypeOf<Response>();
await httpCtx.connections.billing.fetch("/v1/invoices", { method: "HEAD" });
// @ts-expect-error -- `send` isn't declared
await httpCtx.connections.billing.fetch("/v1/invoices", { method: "POST" });
// It has no action members.
expectTypeOf(httpCtx.connections.billing).not.toHaveProperty("get");
await httpCtx.connections.webhook.fetch("/hooks", {
  method: "POST",
  body: "{}",
});
// @ts-expect-error -- `get` isn't declared, so the method is required
await httpCtx.connections.webhook.fetch("/hooks");
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
const runs = await graspCtx.grasp.statistics.read({
  measure: "platform.workflow_runs",
  days: 30,
  apps: ["app_1"],
  groupBy: ["app"],
});
expectTypeOf(runs.groups[0]?.count).toEqualTypeOf<number | undefined>();
// Only the platform's functions are members, and there's no `call`.
expectTypeOf(graspCtx.grasp.statistics).not.toHaveProperty("write");
expectTypeOf(graspCtx.grasp).not.toHaveProperty("call");
await graspCtx.grasp.statistics.read({
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
const brain = permission.brain({ operations: ["recall"] });
const guests = permission.guests({ operations: ["list", "revoke"] });
declare const brainCtx: ActionCtx<typeof brain | typeof guests>;
expectTypeOf(
  brainCtx.brain.recall({ question: "leave", budget: { tokens: 800 } })
).resolves.toEqualTypeOf<BrainPack>();
// The question, the budget and, to read the past, the moment: nothing else.
await brainCtx.brain.recall({
  question: "leave",
  budget: { tokens: 800 },
  asOf: "2026-03-14T23:59:59.999+01:00",
});
// @ts-expect-error -- a recall has a budget
await brainCtx.brain.recall({ question: "leave" });
await brainCtx.brain.recall({
  question: "leave",
  budget: { tokens: 800 },
  // @ts-expect-error -- it reads as the person the call acts for, never another
  person: "someone",
});
// The Brain's skills: only the operations declared, each its own shapes.
const skillsBrain = permission.brain({
  operations: ["skills.select", "skills.read"],
});
declare const skillsCtx: ActionCtx<typeof skillsBrain>;
expectTypeOf(
  skillsCtx.brain.skills.select({ task: "pay an invoice" })
).resolves.toEqualTypeOf<BrainSkillsSelected>();
expectTypeOf(
  skillsCtx.brain.skills.read({
    skill: { scope: "grasp", name: "draw-a-workflow", version: 1 },
  })
).resolves.toEqualTypeOf<BrainSkillText>();
// @ts-expect-error -- a skill is read at a version
await skillsCtx.brain.skills.read({ skill: { scope: "grasp", name: "x" } });
expectTypeOf(skillsCtx.brain).not.toHaveProperty("recall");
expectTypeOf(brainCtx.brain).not.toHaveProperty("skills");
const selectOnly = permission.brain({ operations: ["skills.select"] });
declare const selectCtx: ActionCtx<typeof selectOnly>;
expectTypeOf(selectCtx.brain.skills).not.toHaveProperty("read");
// Only the operations each declares.
await brainCtx.guests.revoke("chat");
expectTypeOf(brainCtx.guests).not.toHaveProperty("invite");

// An action that lists none of them reaches none of them.
declare const bare: ActionCtx;
expectTypeOf(bare).not.toHaveProperty("ai");
expectTypeOf(bare).not.toHaveProperty("brain");
expectTypeOf(bare).not.toHaveProperty("guests");
expectTypeOf(bare.connections).not.toHaveProperty("mail");
expectTypeOf(bare).not.toHaveProperty("grasp");
