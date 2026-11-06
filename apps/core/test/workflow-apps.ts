/**
 * Apps and workflows for the tests of workflow runs, shared by the files
 * they are split across: one file holds only so many runs' worth of
 * workers.
 */
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { expect, vi } from "vite-plus/test";

import { callAppFunction } from "../src/app-functions.ts";
import { appDefinition } from "./app-definitions.ts";
import type { release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";

/** Someone signed in, with their API. */
type Builder = Parameters<typeof release>[0];

/**
 * The sample App, of spec 8's layout, that a run test's workflows call
 * (`env.APP.callFunction`) and the test reads through a page's call
 * (`sampleCall`):
 * - `counter.hit` counts how often a step's code really ran, and answers
 *   that count. Each run of the step's code names itself with an ID of
 *   its own (`execution`, `hitCall`): an action's nested mutations take
 *   keys derived from its input, so each run's bump is fresh and counts,
 *   overlapping runs too, where a receipted mutation called under the
 *   step's key would answer a rerun from its receipt (GRA-656's M2).
 * - `counter.hits` reads a counter; `counter.bump` adds one to it, once
 *   per call key: a test opens a gate with it, which a step waits on by
 *   reading `counter.hits` until it is above 0.
 * - `ledger.book` keeps an entry for whoever the call acts for, and
 *   answers whose it is; `ledger.purchaseOrder` finds a purchase order.
 *
 * With `ai`, it declares the `ai` permission with that bound on the
 * answer, which its workflows' AI steps go through (`step.llm`'s
 * `binding`, `"ai"`). A step may ask twice, so each ask gets half. A
 * binding holds the whole bound to what its model can answer, as an
 * action would ask for all of it: at most 6,000 tokens on Llama 3.3.
 */
export const sampleApp = ({ ai }: { ai?: number } = {}): Record<
  string,
  string
> => ({
  ...appDefinition({
    name: "Invoices",
    tables: {
      counters: {
        fields: { name: "v.string()", count: "v.number()" },
        indexes: { by_name: ["name"] },
        access: { read: "appMembers", write: "appMembers" },
      },
      ledger: {
        fields: { invoice: "v.string()", total: "v.number()" },
        access: { read: "owner", write: "owner" },
      },
    },
    permissions: [
      'permission.connection("send", { contract: "composio.mail@1", actions: ["MAIL_SEND"] })',
      ...(ai === undefined
        ? []
        : [`permission.ai({ maxOutputTokens: ${String(ai)} })`]),
    ],
  }),
  "server/counter.ts": `import { v } from "@grasp-os/sdk";
import { action, mutation, query } from "@server/_generated/server";

export const hits = query({
  args: { name: v.string() },
  returns: v.number(),
  handler: async (ctx, args) =>
    (await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", args.name)).first())?.count ?? 0,
});

export const bump = mutation({
  args: { name: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", args.name)).first();
    if (row === null) {
      await ctx.db.insert("counters", { name: args.name, count: 1 });
      return 1;
    }
    await ctx.db.patch("counters", row._id, { count: row.count + 1 }, { expectedRevision: row._rev });
    return row.count + 1;
  },
});

export const hit = action({
  args: { name: v.string(), execution: v.string() },
  returns: v.number(),
  uses: [bump],
  handler: async (ctx, args) => await ctx.runMutation(bump, { name: args.name }),
});

`,
  "server/ledger.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query } from "@server/_generated/server";

export const purchaseOrder = query({
  args: { number: v.string() },
  returns: v.union(v.object({ amount: v.number() }), v.null()),
  handler: async (_ctx, args) => (args.number === "PO-1" ? { amount: 800_000 } : null),
});

export const book = mutation({
  args: { invoice: v.string(), total: v.number() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("ledger", args);
    const entry = await ctx.db.get("ledger", id);
    return "ledger-" + args.invoice + "-for-" + String(entry?._ownerId);
  },
});
`,
  "server/effects.ts": `import { permissions } from "../grasp.config.ts";

export const send = permissions.send;

export const invoice = { to: "ben@acme.test", subject: "Invoice INV-7" };

// What a connector answered, or the code it refused with.
export const outcome = async (work: () => Promise<unknown>): Promise<unknown> => {
  try {
    return await work();
  } catch (error) {
    return { refused: String(Reflect.get(Object(error), "code")) };
  }
};
`,
  "server/mail.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";

import { invoice, outcome, send } from "./effects.ts";

// Mails the invoice, under the call's own key: what the connector
// answered, or its refusal, as JSON.
export const mail = action({
  args: {},
  returns: v.string(),
  uses: [send],
  handler: async (ctx) => JSON.stringify(await outcome(async () => await ctx.connections.send.call("MAIL_SEND", invoice))),
});

// As mail, naming a key of its own past the client's types: refused, as
// the host derives every request's key.
export const mailOwnKey = action({
  args: {},
  returns: v.string(),
  uses: [send],
  handler: async (ctx) =>
    JSON.stringify(
      await outcome(async () => {
        const call: unknown = Reflect.get(ctx.connections.send, "call");
        if (typeof call !== "function") {
          throw new TypeError("The client has no call");
        }
        return await Reflect.apply(call, ctx.connections.send, ["MAIL_SEND", invoice, { idempotencyKey: crypto.randomUUID() }]);
      })
    ),
});

`,
});

/**
 * Workflow code calling the sample App's function `path`, of `kind`, with
 * the input `input` (code), as a step calls it: its value, read as `type`,
 * or the function's refusal thrown, with its code. What a binding answers
 * is `unknown` to a workflow's type check: the call's answer is read as
 * what `env.APP.callFunction` answers.
 */
export const appCall = (
  path: string,
  kind: "query" | "mutation" | "action",
  input: string,
  /** The value's type, as the step code reads it (a type, as code). */
  type = "Json"
): string =>
  `((answer) => { if (!answer.ok) { throw Object.assign(new Error(answer.error.message), { code: answer.error.code }); } return answer.value as ${type}; })((await env.APP.callFunction({ name: ${JSON.stringify(path)}, kind: ${JSON.stringify(kind)} }, ${input})) as { ok: true; value: unknown } | { ok: false; error: { message: string; code: string } })`;

/** Workflow code counting a run of `name` (code), answering the count. */
export const hitCall = (name: string): string =>
  appCall(
    "counter.hit",
    "action",
    `{ name: ${name}, execution: crypto.randomUUID() }`,
    "number"
  );

/**
 * What `by` gets calling the sample App's function `path` of `app`'s
 * current version with `input`, as a page calls it: its value, or the
 * code it was refused with.
 */
export const sampleCall = async (
  by: Builder,
  app: string,
  path: string,
  kind: "query" | "mutation" | "action",
  input: unknown
): Promise<unknown> => {
  const appId = appIdSchema.parse(app);
  const answered = await callAppFunction(
    env,
    await by.api.whoami(),
    appId,
    JSON.stringify({
      reference: { name: path, kind },
      input,
    })
  );
  return answered.result.ok
    ? answered.result.value
    : `refused:${answered.result.error.code}`;
};

/** How often the sample App counted `name`, as `by` reads it. */
export const hitsOf = async (
  by: Builder,
  app: string,
  name: string
): Promise<number> => {
  const hits = await sampleCall(by, app, "counter.hits", "query", { name });
  if (typeof hits !== "number") {
    throw new TypeError(`The counter didn't read: ${String(hits)}`);
  }
  return hits;
};

/** Opens the gate `name` of the sample App (`counter.bump`), as `by`. */
export const openGate = async (
  by: Builder,
  app: string,
  name = "gate"
): Promise<void> => {
  const opened = await sampleCall(by, app, "counter.bump", "mutation", {
    name,
  });
  if (typeof opened !== "number") {
    throw new TypeError(`The gate didn't open: ${String(opened)}`);
  }
};

/**
 * A run's audit events, once the log has `last` of them, each as its
 * action and what it says of the step, the reason and the error, sorted.
 */
export const runEvents = async (run: string, last: string): Promise<string[]> =>
  await vi.waitFor(
    async () => {
      const events = await allEvents();
      const ofRun = events.filter(({ target }) => target?.id === run);
      expect(ofRun.map(({ action }) => action)).toContain(last);
      return ofRun
        .map(({ action, detail }) =>
          [action, detail.reason, detail.feature, detail.step, detail.error]
            .filter((part) => part !== undefined)
            .join(" ")
        )
        .toSorted();
    },
    { timeout: 10_000, interval: 100 }
  );

/** The mail each test's workflow sends. */
export const invoiceMail = { to: "ben@acme.test", subject: "Invoice INV-7" };
