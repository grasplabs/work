// Compile-time guarantees of connector resources (spec 12): a declaration
// names a generated contract of the release (the SDK's connector catalog,
// `connector-catalog.gen.ts`) and some of its actions, and
// `ctx.resources.<alias>.call(action, args)` then infers that action's
// arguments and answer from the contract alone, without a cast or a
// generic argument. This file is type-checked by `vp check` and never run:
// every `@ts-expect-error` below must stay an error.
import { expectTypeOf } from "vite-plus/test";

import { resource } from "../src/index.ts";
import type { ConnectorAction, ConnectorContract } from "../src/index.ts";
import { serverModule } from "../src/server.ts";
import type { ActionCtx } from "../src/server.ts";
import type { JsonValue } from "../src/value-descriptor.ts";
import { defineSchema, defineTable, v } from "../src/values.ts";

const { action } = serverModule(
  defineSchema({ notes: defineTable({ title: v.string() }) })
);

const mail = resource.connector("mail", {
  contract: "microsoft-365.mail@1",
  actions: ["send", "list"],
});
const gmail = resource.connector("gmail", {
  contract: "google-workspace.mail@1",
  actions: ["send", "labels"],
});

// The catalog names the release's contracts and their actions.
expectTypeOf<"microsoft-365.mail@1">().toExtend<ConnectorContract>();
expectTypeOf<"google-workspace.files@1">().toExtend<ConnectorContract>();
expectTypeOf<"grasp.mail@1">().not.toExtend<ConnectorContract>();
expectTypeOf<ConnectorAction<"microsoft-365.mail@1">>().toEqualTypeOf<
  "createDraft" | "get" | "list" | "move" | "readAttachment" | "send"
>();

declare const ctx: ActionCtx<readonly [typeof mail, typeof gmail]>;

// Arguments as the contract takes them: optional fields may be left out.
const sent = await ctx.resources.mail.call("send", {
  mailbox: "team@acme.test",
  subject: "Hello",
  body: "Hi.",
  to: ["ada@acme.test"],
});
// The answer as the contract gives it, with no narrowing first.
expectTypeOf(sent).toEqualTypeOf<{ mailbox: string; sent: true }>();
await ctx.resources.mail.call("send", {
  mailbox: "team@acme.test",
  subject: "Hello",
  body: "<p>Hi.</p>",
  bodyType: "html",
  to: ["ada@acme.test"],
  cc: ["grace@acme.test"],
});

// Each action has its own types, and so does each contract.
const listed = await ctx.resources.mail.call("list", {
  mailbox: "team@acme.test",
  top: 10,
});
expectTypeOf(listed.nextPage).toEqualTypeOf<string | null>();
expectTypeOf(listed.messages[0]?.subject).toEqualTypeOf<
  string | null | undefined
>();
const gmailSent = await ctx.resources.gmail.call("send", {
  mailbox: "me",
  subject: "Hello",
  body: "Hi.",
  to: ["ada@acme.test"],
});
expectTypeOf(gmailSent.threadId).toEqualTypeOf<string | null>();
expectTypeOf(
  ctx.resources.gmail.call("labels", { mailbox: "me" })
).resolves.toEqualTypeOf<{
  labels: { id: string; name: string; type: string | null }[];
  mailbox: string;
}>();

// The same through an action's `uses`: its handler's answer is typed by it.
action({
  args: { to: v.string().email() },
  returns: v.string(),
  uses: [mail],
  handler: async (context, args) => {
    const answer = await context.resources.mail.call("send", {
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
resource.connector("x", { contract: "grasp.mail@1", actions: ["send"] });
// Refused: an action its contract doesn't have, though another one does.
resource.connector("other", {
  contract: "microsoft-365.mail@1",
  // @ts-expect-error -- Google's mail has labels; Microsoft's hasn't
  actions: ["labels"],
});
resource.connector("other", {
  contract: "microsoft-365.calendar@1",
  // @ts-expect-error -- `send` is mail's, not the calendar's
  actions: ["send"],
});

// Refused: an action the declaration doesn't list, though its contract has it.
// @ts-expect-error -- `move` isn't declared
await ctx.resources.mail.call("move", {});

await ctx.resources.mail.call("send", {
  mailbox: "team@acme.test",
  subject: "Hello",
  body: "Hi.",
  // @ts-expect-error -- recipients are a list
  to: "ada@acme.test",
});
// @ts-expect-error -- `to` is required
await ctx.resources.mail.call("send", {
  mailbox: "team@acme.test",
  subject: "Hello",
  body: "Hi.",
});
await ctx.resources.mail.call("send", {
  mailbox: "team@acme.test",
  subject: "Hello",
  body: "Hi.",
  to: ["ada@acme.test"],
  // @ts-expect-error -- not a body type the contract has
  bodyType: "markdown",
});
await ctx.resources.mail.call("send", {
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
await ctx.resources.mail.call(either, { mailbox: "team@acme.test" });
// Narrowed, each branch is typed by its own action, and so is its answer.
const answer =
  either === "send"
    ? await ctx.resources.mail.call(either, {
        mailbox: "team@acme.test",
        subject: "Hello",
        body: "Hi.",
        to: ["ada@acme.test"],
      })
    : await ctx.resources.mail.call(either, { mailbox: "team@acme.test" });
expectTypeOf(answer).toExtend<
  { mailbox: string; sent: true } | { nextPage: string | null }
>();
// A literal action still infers that action alone, answer included.
expectTypeOf(
  ctx.resources.mail.call("list", { mailbox: "team@acme.test" })
).resolves.toHaveProperty("messages");
expectTypeOf(
  ctx.resources.mail.call("list", { mailbox: "team@acme.test" })
).resolves.not.toHaveProperty("sent");

// A Composio toolkit's contract (`composio.<toolkit>@1`): its tools change
// without a release, so it isn't in the catalog and its calls are untyped
// JSON, checked by the host against the contract its binding pinned.
const crm = resource.connector("crm", {
  contract: "composio.hubspot@1",
  actions: ["HUBSPOT_LIST_CONTACTS"],
});
expectTypeOf<"composio.hubspot@1">().toExtend<ConnectorContract>();
expectTypeOf<ConnectorAction<"composio.hubspot@1">>().toEqualTypeOf<string>();
declare const crmCtx: ActionCtx<readonly [typeof crm]>;
const contacts = await crmCtx.resources.crm.call("HUBSPOT_LIST_CONTACTS", {
  limit: 5,
});
expectTypeOf(contacts).toEqualTypeOf<JsonValue>();
// @ts-expect-error -- arguments are a JSON object
await crmCtx.resources.crm.call("HUBSPOT_LIST_CONTACTS", "all");
// @ts-expect-error -- only the actions it declares
await crmCtx.resources.crm.call("HUBSPOT_CREATE_CONTACT", {});
// @ts-expect-error -- Composio contracts are generated at version 1 only
resource.connector("old", { contract: "composio.hubspot@2", actions: ["X"] });
// @ts-expect-error -- not a Composio contract: a family of no native connector
resource.connector("lookalike", { contract: "hubspot.crm@1", actions: ["X"] });

// Another store's public operations: each declared path's arguments and
// return, inferred from the declaration alone.
const ledger = resource.store("ledger", {
  operations: {
    "entries.list": {
      kind: "query",
      args: { limit: v.number().optional() },
      returns: v.array(v.object({ amount: v.number() })),
    },
    "entries.add": {
      kind: "mutation",
      args: { amount: v.number() },
      returns: v.null(),
    },
  },
});
declare const ledgerCtx: ActionCtx<readonly [typeof ledger]>;
expectTypeOf(
  ledgerCtx.resources.ledger.call("entries.list", {})
).resolves.toEqualTypeOf<{ amount: number }[]>();
expectTypeOf(
  ledgerCtx.resources.ledger.call("entries.add", { amount: 3 })
).resolves.toEqualTypeOf<null>();
// @ts-expect-error -- only the operations it declares
await ledgerCtx.resources.ledger.call("entries.remove", {});
// @ts-expect-error -- arguments as the operation declares them
await ledgerCtx.resources.ledger.call("entries.add", { amount: "3" });
// A path known only as one of several: its arguments must fit whichever
// it is, so arguments that fit only `entries.list` are refused.
declare const entriesPath: "entries.add" | "entries.list";
// @ts-expect-error -- fits `entries.list`, but not `entries.add`
await ledgerCtx.resources.ledger.call(entriesPath, {});
resource.store("bad", {
  // @ts-expect-error -- a store's actions are never called
  operations: { ping: { kind: "action", args: {}, returns: v.null() } },
});
