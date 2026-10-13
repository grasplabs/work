/**
 * Apps and workflows for the tests of workflow runs, shared by the files
 * they are split across: one file holds only so many runs' worth of
 * workers.
 */
import { appIdSchema } from "@grasp-os/shared/ids";
import type { ModelBindingBudgetInput } from "@grasp-os/shared/resource-bindings";
import { env } from "cloudflare:workers";
import { expect, vi } from "vite-plus/test";

import { findApp } from "../src/apps.ts";
import { approveResourceBinding } from "../src/resource-bindings.ts";
import { release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import type { Idp } from "./idp.ts";
import { person } from "./sealed-apps.ts";

/**
 * A registration of spec 8's layout beside an App's server, declaring a
 * text model resource for each of `bounds`' aliases, which its workflows'
 * AI steps go through (`step.llm`'s `binding`), each with that bound on
 * the answer. A step may ask twice, so each ask gets half: twice what the
 * gateway gives a model's answer when a call says nothing (16,384 tokens,
 * and a quarter of Llama 3.3's window, 6,000) asks for as much as before.
 */
export const modelRegistration = (
  bounds: Record<string, number>
): Record<string, string> => ({
  "schema.ts": `import { defineSchema } from "@grasp-os/sdk";

export default defineSchema({});
`,
  "app.ts": `import { app, resource } from "@grasp-os/sdk";

import schema from "./schema.ts";

${Object.entries(bounds)
  .map(
    ([alias, tokens]) =>
      `export const ${alias} = resource.model("${alias}", { maxOutputTokens: ${tokens} });\n`
  )
  .join("")}
export default app({
  name: "Models",
  schema,
  access: { tables: {} },
  operations: {},
  internalOperations: {},
  screens: [],
  uses: [${Object.keys(bounds).join(", ")}],
});
`,
});

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

/** Someone signed in, with their API. */
type Builder = Parameters<typeof release>[0];

/**
 * The sample App's server code: purchase orders, a ledger that books each
 * entry once per idempotency key, counters that show how often a step
 * really ran, and statistics points, recorded around a mail, by name, or
 * once a held search is let go.
 */
export const server = `import { DurableObject } from "cloudflare:workers";

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

/** A new App with the sample server and `files`. */
export const appWith = async (
  builder: Builder,
  files: Record<string, string>
): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Invoices" });
  await release(builder, id, { "app/server.ts": server, ...files });
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
