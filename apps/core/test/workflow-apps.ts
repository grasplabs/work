/**
 * Apps and workflows for the tests of workflow runs, shared by the files
 * they are split across: one file holds only so many runs' worth of
 * workers.
 */
import { appIdSchema } from "@grasp-os/shared/ids";
import type { ModelBindingBudgetInput } from "@grasp-os/shared/resource-bindings";
import { env } from "cloudflare:workers";
import { expect, vi } from "vite-plus/test";

import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import { findApp } from "../src/apps.ts";
import { approveResourceBinding } from "../src/resource-bindings.ts";
import { release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import type { Idp } from "./idp.ts";
import { person } from "./sealed-apps.ts";

/** Someone signed in, with their API. */
type Builder = Parameters<typeof release>[0];

/**
 * The sample App, of spec 8's layout, that a run test's workflows call
 * (`env.APP.callFunction`) and the test reads through a screen's call
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
 * It declares a text model resource for each of `models`' aliases, which
 * its workflows' AI steps go through (`step.llm`'s `binding`), each with
 * that bound on the answer. A step may ask twice, so each ask gets half.
 * A binding holds the whole bound to what its model can answer, as an
 * action would ask for all of it: at most 6,000 tokens on Llama 3.3.
 */
export const sampleApp = ({
  models = {},
}: { models?: Record<string, number> } = {}): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  counters: defineTable({ name: v.string(), count: v.number() }).index("by_name", ["name"]),
  ledger: defineTable({ invoice: v.string(), total: v.number() }),
});
`,
  "operations/sample.ts": `import { v } from "@grasp-os/sdk";
import { action, mutation, query } from "#grasp/server";

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
  "operations/effects.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

import { bump } from "./sample.ts";

export const stats = resource.statistics("stats", { operations: ["record", "read"] });

export const send = resource.connector("send", { contract: "composio.mail@1", actions: ["MAIL_SEND"] });

export const search = resource.connector("search", { contract: "composio.mail@1", actions: ["MAIL_SEARCH"] });

const invoice = { to: "ben@acme.test", subject: "Invoice INV-7" };

// What a connector answered, or the code it refused with.
const outcome = async (work: () => Promise<unknown>): Promise<unknown> => {
  try {
    return await work();
  } catch (error) {
    return { refused: String(Reflect.get(Object(error), "code")) };
  }
};

export const point = action({
  args: { measures: v.array(v.string()) },
  returns: v.null(),
  uses: [stats],
  handler: async (ctx, args) => {
    for (const measure of args.measures) {
      await ctx.resources.stats.record({ measure, value: 1 });
    }
    return null;
  },
});

// How many points of measure the App's statistics hold of today and
// yesterday: a run that crosses midnight counts the same.
export const points = action({
  args: { measure: v.string() },
  returns: v.number(),
  uses: [stats],
  handler: async (ctx, args) => {
    const { groups } = await ctx.resources.stats.read({ measure: args.measure, days: 2 });
    return groups[0]?.count ?? 0;
  },
});

// Waits at the mail server, which holds the search until the test lets it
// go, then records a point of measure, and counts whether it was
// taken (measure:recorded) or refused, the search or the point.
export const pointAfter = action({
  args: { measure: v.string(), execution: v.string() },
  returns: v.null(),
  uses: [search, stats, bump],
  handler: async (ctx, args) => {
    try {
      await ctx.resources.search.call("MAIL_SEARCH", { query: "hold " + args.measure });
    } catch {
      await ctx.runMutation(bump, { name: args.measure + ":refused" });
      return null;
    }
    try {
      await ctx.resources.stats.record({ measure: args.measure, value: 1 });
      await ctx.runMutation(bump, { name: args.measure + ":recorded" });
    } catch {
      await ctx.runMutation(bump, { name: args.measure + ":refused" });
    }
    return null;
  },
});

// Mails the invoice, under the call's own key: what the connector
// answered, or its refusal, as JSON.
export const mail = action({
  args: {},
  returns: v.string(),
  uses: [send],
  handler: async (ctx) => JSON.stringify(await outcome(async () => await ctx.resources.send.call("MAIL_SEND", invoice))),
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
        const call: unknown = Reflect.get(ctx.resources.send, "call");
        if (typeof call !== "function") {
          throw new TypeError("The client has no call");
        }
        return await Reflect.apply(call, ctx.resources.send, ["MAIL_SEND", invoice, { idempotencyKey: crypto.randomUUID() }]);
      })
    ),
});

// Records two points alike, mails the invoice, and records a third once
// the mail was sent.
export const mailCounted = action({
  args: {},
  returns: v.string(),
  uses: [send, stats],
  handler: async (ctx) => {
    await ctx.resources.stats.record({ measure: "mails", value: 1 });
    await ctx.resources.stats.record({ measure: "mails", value: 1 });
    const sent = await outcome(async () => await ctx.resources.send.call("MAIL_SEND", invoice));
    if (!("refused" in Object(sent))) {
      await ctx.resources.stats.record({ measure: "sent", value: 1 });
    }
    return JSON.stringify(sent);
  },
});
`,
  "app.ts": `import { app, resource } from "@grasp-os/sdk";

import { mail, mailCounted, mailOwnKey, point, pointAfter, points, search, send, stats } from "./operations/effects.ts";
import { book, bump, hit, hits, purchaseOrder } from "./operations/sample.ts";
import schema from "./schema.ts";

${Object.entries(models)
  .map(
    ([alias, tokens]) =>
      `export const ${alias} = resource.model("${alias}", { maxOutputTokens: ${tokens} });\n`
  )
  .join("")}
export default app({
  name: "Invoices",
  schema,
  access: {
    tables: {
      counters: { read: "appMembers", write: "appMembers" },
      ledger: { read: "owner", write: "owner" },
    },
  },
  operations: {
    counter: { hit, hits, bump },
    ledger: { book, purchaseOrder },
    stats: { point, points, pointAfter },
    mail: { mail, mailOwnKey, mailCounted },
  },
  internalOperations: {},
  screens: [],
  uses: [stats, send, search${Object.keys(models)
    .map((alias) => `, ${alias}`)
    .join("")}],
});
`,
});

/**
 * The sample App (`sampleApp`), declaring a text model resource for each
 * of `bounds`' aliases.
 */
export const modelRegistration = (
  bounds: Record<string, number>
): Record<string, string> => sampleApp({ models: bounds });

/**
 * Workflow code calling the sample App's function `path`, of `kind`, with
 * the input `input` (code), as a step calls it: its value, or the
 * function's refusal thrown, with its code.
 */
export const appCall = (
  path: string,
  kind: "query" | "mutation" | "action",
  input: string
): string =>
  `((answer) => { if (!answer.ok) { throw Object.assign(new Error(answer.error.message), { code: answer.error.code }); } return answer.value; })(await env.APP.callFunction({ contractId: ${JSON.stringify(path)}, kind: ${JSON.stringify(kind)} }, ${input}))`;

/** Workflow code counting a run of `name` (code), answering the count. */
export const hitCall = (name: string): string =>
  appCall(
    "counter.hit",
    "action",
    `{ name: ${name}, execution: crypto.randomUUID() }`
  );

/** Workflow code reading the counter `name` (code). */
export const hitsCall = (name: string): string =>
  appCall("counter.hits", "query", `{ name: ${name} }`);

/**
 * What `by` gets calling the sample App's function `path` of `app`'s
 * current version with `input`, as a screen calls it: its value, or the
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
  const { currentVersion } = await findApp(env, appId);
  const current = await loadRelease(env, appId, currentVersion ?? 0);
  const answered = await callAppFunction(
    env,
    await by.api.whoami(),
    appId,
    JSON.stringify({
      reference: {
        resourceId: appId,
        resourceVersion: current.manifest.resourceVersion,
        contractId: path,
        fingerprint: current.fingerprints[path] ?? "",
        kind,
      },
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

/** How many points of `measure` the sample App's statistics hold, as `by` reads them. */
export const pointsOf = async (
  by: Builder,
  app: string,
  measure: string
): Promise<number> => {
  const points = await sampleCall(by, app, "stats.points", "action", {
    measure,
  });
  if (typeof points !== "number") {
    throw new TypeError(`The statistics didn't read: ${String(points)}`);
  }
  return points;
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
 * An admin's binding of the sample App's resource `alias` to `target`, for
 * the version current now.
 */
const bindSample = async (
  app: string,
  alias: string,
  target: { kind: "statistics" } | { kind: "connector"; permissionId: string }
) => {
  const { currentVersion } = await findApp(env, appIdSchema.parse(app));
  return await approveResourceBinding(env, await person("admin"), {
    app,
    alias,
    target,
    reviewed: { version: currentVersion ?? 0 },
  });
};

/** Binds the sample App's statistics (`stats`) to its own measures. */
export const bindStats = async (app: string) =>
  await bindSample(app, "stats", { kind: "statistics" });

/**
 * Gives the sample App's mail connector `alias` (`send`, or `search`) the
 * connection `connectionId` (allowing `mailForApps`): a permission on its
 * tool (`MAIL_SEND`, or `MAIL_SEARCH`) `requester` asks for and an admin
 * grants, and the admin's binding to it.
 */
export const bindMail = async (
  idp: Idp,
  requester: Builder,
  app: string,
  connectionId: string,
  alias: "send" | "search"
) => {
  const permissionId = await requestGranted(idp, requester, {
    subject: { type: "app", appId: app },
    object: { type: "connection", connectionId },
    actions: [alias === "send" ? "MAIL_SEND" : "MAIL_SEARCH"],
    binding: alias.toUpperCase(),
  });
  return await bindSample(app, alias, { kind: "connector", permissionId });
};

/**
 * An admin's binding of App `app`'s model resource `alias` to `model`,
 * with `budget`, for the version current now: the model must be one the
 * deployment allows as it is approved.
 */
export const bindModel = async (
  app: string,
  alias: string,
  model: string,
  budget?: ModelBindingBudgetInput
) => {
  const { currentVersion } = await findApp(env, appIdSchema.parse(app));
  return await approveResourceBinding(env, await person("admin"), {
    app,
    alias,
    target: { kind: "model", model },
    reviewed: { version: currentVersion ?? 0 },
    ...(budget === undefined ? {} : { budget }),
  });
};

/**
 * A workflow of the given steps' code, run as `id`, with a test that
 * mocks every step it names, so any workflow passes activation.
 */
export const workflowFiles = (
  id: string,
  body: string,
  mocks: Record<string, unknown> = {}
): Record<string, string> => ({
  [`workflows/${id}.ts`]: `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("${id}", { params: {}, input: z.unknown() }, async (step, { env, input }) => {
${body}
});
`,
  [`workflows/${id}.workflow-tests.ts`]: `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./${id}.ts";

export default workflowTests(definition, [
  { name: "runs", mocks: ${JSON.stringify(mocks)}, expect: {} },
]);
`,
});

/**
 * A new App of `builder`'s: the sample App (`sampleApp`), and `files`,
 * current.
 */
export const appWith = async (
  builder: Builder,
  files: Record<string, string>
): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Invoices" });
  await release(builder, id, { ...sampleApp(), ...files });
  return id;
};

/**
 * A new App of `builder`'s with only `files`, its workflows, and no App
 * code to seal: for the tests of what making a version current does with
 * its workflows alone, whose database races would otherwise land in the
 * seal's writes.
 */
export const workflowsApp = async (
  builder: Builder,
  files: Record<string, string>
): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Invoices" });
  await release(builder, id, files);
  return id;
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

/**
 * Gives the App `MAIL`, for sending on the connection; an admin grants it.
 * Answers the permission's ID.
 */
export const grantMail = async (
  idp: Idp,
  requester: Builder,
  app: string,
  connectionId: string
): Promise<string> =>
  await requestGranted(idp, requester, {
    subject: { type: "app", appId: app },
    object: { type: "connection", connectionId },
    actions: ["mail.send"],
    binding: "MAIL",
  });

/** The mail each test's workflow sends. */
export const invoiceMail = { to: "ben@acme.test", subject: "Invoice INV-7" };

/**
 * A workflow `mailer` that sends the invoice mail in its side-effect step
 * `send`, with the step's idempotency key, with the step's `options`; then
 * runs `after` in the step, with the connector's answer as `sent`.
 */
export const mailer = (options: string, after = "") =>
  workflowFiles(
    "mailer",
    `  return await step.do(
    "send",
    { description: "Send the invoice", sideEffect: true, input: ${JSON.stringify(invoiceMail)}, ${options} },
    async ({ idempotencyKey, input: mail }) => {
      const sent = JSON.parse((await env.MAIL.call("mail.send", mail, { idempotencyKey })).output);
${after}
      return sent;
    }
  );`,
    { send: { messageId: "mocked" } }
  );
