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
 *   that count. It is an action: it reads the live count with a query
 *   (never answered from a receipt), then bumps the counter through
 *   receipted mutations until one answers above what it read. A step run
 *   again under the same key gets its earlier bumps' receipts, each at
 *   most what it read, and its next place is fresh: so a rerun counts,
 *   where a plain receipted mutation would answer 1 again (GRA-656's M2).
 * - `counter.hits` reads a counter; `counter.bump` adds one to it, once
 *   per call key: a test opens a gate with it, which a step waits on by
 *   reading `counter.hits` until it is above 0.
 * - `ledger.book` keeps an entry for whoever the call acts for, and
 *   answers whose it is.
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
  args: { name: v.string() },
  returns: v.number(),
  uses: [hits, bump],
  handler: async (ctx, args) => {
    const before = await ctx.runQuery(hits, { name: args.name });
    // A step's attempts are at most five: a sixth place is never needed.
    for (let place = 0; place < 6; place += 1) {
      const counted = await ctx.runMutation(bump, { name: args.name });
      if (counted > before) {
        return counted;
      }
    }
    throw new Error("The counter ran out of places");
  },
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
  "app.ts": `import { app, resource } from "@grasp-os/sdk";

import { book, bump, hit, hits } from "./operations/sample.ts";
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
  operations: { counter: { hit, hits, bump }, ledger: { book } },
  internalOperations: {},
  screens: [],
  uses: [${Object.keys(models).join(", ")}],
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
  appCall("counter.hit", "action", `{ name: ${name} }`);

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

/** Opens the gate `name` of the sample App (`counter.bump`), as `by`. */
export const openGate = async (
  by: Builder,
  app: string,
  name = "gate"
): Promise<void> => {
  await sampleCall(by, app, "counter.bump", "mutation", { name });
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
 * The v1 sample server, for the run tests not moved onto the sample App
 * yet (GRA-656's later slices): purchase orders, a ledger that books each
 * entry once per idempotency key, counters that show how often a step
 * really ran, and statistics points, recorded around a mail, by name, or
 * once a held search is let go.
 */
export const v1Server = `import { DurableObject } from "cloudflare:workers";

type Caller = { userId: string; idempotencyKey?: string };

export class App extends DurableObject {
  hit(_caller: Caller, name: string): number {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hits (name TEXT PRIMARY KEY, count INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("INSERT INTO hits VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET count = count + 1", name);
    return this.hits(_caller, name);
  }

  hits(_caller: Caller, name: string): number {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hits (name TEXT PRIMARY KEY, count INTEGER NOT NULL)");
    const [row] = this.ctx.storage.sql.exec("SELECT count FROM hits WHERE name = ?", name).toArray();
    return Number(row?.count ?? 0);
  }

  // Takes \`ms\` milliseconds, holding the App's turn meanwhile.
  async pause(_caller: Caller, ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  purchaseOrder(_caller: Caller, number: string): { amount: number } | null {
    return number === "PO-1" ? { amount: 800_000 } : null;
  }

  book(caller: Caller, entry: { invoice: string; total: number }, key: string): string {
    this.hit(caller, "book:" + key);
    return "ledger-" + entry.invoice + "-for-" + caller.userId;
  }

  // Mails the invoice with the caller's key, or with a key of its own.
  async mail(caller: Caller, ownKey: boolean): Promise<unknown> {
    const idempotencyKey = ownKey ? crypto.randomUUID() : caller.idempotencyKey;
    try {
      const { output } = await (this.env as any).MAIL.call(
        caller,
        "mail.send",
        { to: "ben@acme.test", subject: "Invoice INV-7" },
        { idempotencyKey }
      );
      return JSON.parse(output);
    } catch (error) {
      return { refused: (error as { code?: string }).code };
    }
  }

  // Records two points alike of the App's statistics, mails the invoice,
  // and records a third once the mail was sent.
  async mailCounted(caller: Caller): Promise<unknown> {
    const stats = (this.env as any).STATISTICS;
    await stats.record(caller, { measure: "mails", value: 1 });
    await stats.record(caller, { measure: "mails", value: 1 });
    const sent = await this.mail(caller, false);
    if (!("refused" in (sent as object))) {
      await stats.record(caller, { measure: "sent", value: 1 });
    }
    return sent;
  }

  // How many points of \`measure\` the App's statistics hold of today
  // and yesterday: a run that crosses midnight counts the same.
  async points(caller: Caller, measure: string): Promise<number> {
    const { groups } = await (this.env as any).STATISTICS.read(caller, { measure, days: 2 });
    return groups[0]?.count ?? 0;
  }

  // Records a point of each of \`measures\`, in that order.
  async point(caller: Caller, ...measures: string[]): Promise<void> {
    for (const measure of measures) {
      await (this.env as any).STATISTICS.record(caller, { measure, value: 1 });
    }
  }

  // Waits at the mail server, its search naming its caller's token, until
  // the test lets it go, then counts \`parked:done\`.
  async parkAtMail(caller: Caller): Promise<void> {
    await (this.env as any).MAIL.call(caller, "mail.search", { query: "hold " + ((caller as { token?: string }).token ?? "") });
    this.hit(caller, "parked:done");
  }

  // Waits at the mail server, which holds its search until the test lets
  // it go (MAIL, granted \`mail.search\`), then records a point of
  // \`measure\`, and counts whether the call was taken
  // (\`measure\`:recorded) or refused, the search's answer or the point.
  async pointAfter(caller: Caller, measure: string): Promise<void> {
    try {
      await (this.env as any).MAIL.call(caller, "mail.search", { query: "hold " + measure });
    } catch {
      this.hit(caller, measure + ":refused");
      return;
    }
    try {
      await this.point(caller, measure);
      this.hit(caller, measure + ":recorded");
    } catch {
      this.hit(caller, measure + ":refused");
    }
  }
}
`;

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
 * A new App with the v1 sample server and `files`, for the run tests not
 * moved onto the sample App yet; GRA-656's last slice removes it.
 */
export const v1AppWith = async (
  builder: Builder,
  files: Record<string, string>
): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Invoices" });
  await release(builder, id, { "app/server.ts": v1Server, ...files });
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

/** Gives the App `MAIL`, for sending on the connection; an admin grants it. */
export const grantMail = async (
  idp: Idp,
  requester: Builder,
  app: string,
  connectionId: string
): Promise<void> => {
  await requestGranted(idp, requester, {
    subject: { type: "app", appId: app },
    object: { type: "connection", connectionId },
    actions: ["mail.send"],
    binding: "MAIL",
  });
};

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
