import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { appErrors } from "@grasp-os/shared/apps";
import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appHost } from "../src/durable-objects.ts";
import { startRun } from "../src/workflows/runs.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { grantReviewed, outlook, release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { confirmedAnswer } from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import {
  endLiveRuns,
  finished,
  leave,
  liveStatus,
  runObject,
  stepDone,
  stopped,
  woken,
} from "./runs.ts";
import { refusal, signedInApi } from "./sign-in.ts";
import {
  appCall,
  appWith,
  bindModel,
  grantMail,
  hitCall,
  hitsOf,
  invoiceMail,
  mailer,
  modelRegistration,
  runEvents,
  sampleApp,
  workflowFiles,
} from "./workflow-apps.ts";

// Workflows are code the agent writes, run for real: committed to an App,
// tested when their version is made current, and run on the engine
// (Workerflow) by the dispatcher, each in an isolate of its own. Time is
// moved on where a run sleeps (`woken`); the outside systems faked
// here are the model provider behind AI Gateway, and a mail provider's MCP
// server behind the real connect (test/mail-server.ts).
//
// A run's audit events are in an outbox by the time the run has ended: the
// dispatcher's end step writes the run's own event with its row, and each
// step's and each connection call's event is written before the step goes
// on. `allEvents` drains the outboxes before it reads, so a test reads them
// once, after the run ended, rather than wait for them: a wait with a
// deadline adds nothing, and one read of the log can take longer than a
// short deadline on a loaded runner.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

const extractionModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * The sample invoice workflow, as an App ships it: it matches the purchase
 * order, reads the total with a model, asks a reviewer above a threshold
 * and books the invoice, through its App's functions.
 */
const invoiceWorkflow = `import { money, person, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "invoice-approval",
  {
    input: z.object({ number: z.string(), purchaseOrder: z.string(), text: z.string() }),
    params: {
      threshold: money({ label: "Review invoices above", currency: "EUR", default: 500_000, sensitive: true }),
      reviewer: person({ label: "Reviewer", default: "role:admin" }),
    },
  },
  async (step, { input, params, env }) => {
    const order = await step.do(
      "match-po",
      { description: "Find the purchase order the invoice refers to", locked: true, input: input.purchaseOrder },
      async ({ input: number }) => await ${appCall("ledger.purchaseOrder", "query", "{ number }", "{ amount: number } | null")}
    );
    if (!order) {
      return { status: "unmatched" };
    }
    const extracted = await step.llm("extract", {
      description: "Read the total and currency from the invoice",
      binding: "extractor",
      instructions: "Read the invoice's total in cents and its ISO 4217 currency.",
      input: input.text,
      schema: z.object({ total: z.int(), currency: z.string() }),
      retries: { limit: 0 },
    });
    if (extracted.total > params.threshold) {
      const decision = await step.decision("review", {
        description: "Ask the reviewer to approve invoices above the limit",
        from: params.reviewer,
        ask: async () => {},
        timeout: "7 days",
      });
      if (decision.timedOut || !decision.approved) {
        return { status: decision.timedOut ? "timedOut" : "rejected" };
      }
    }
    const entry = await step.do(
      "book",
      {
        description: "Book the invoice in the ledger",
        sideEffect: true,
        locked: true,
        input: { invoice: input.number, total: extracted.total },
      },
      async ({ input: booking }) => await ${appCall("ledger.book", "mutation", "booking", "string")}
    );
    return { status: "booked", entry };
  }
);
`;

const invoiceTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import invoice from "./invoice-approval.ts";

const input = { number: "INV-7", purchaseOrder: "PO-1", text: "Total 8,000 EUR" };

export default workflowTests(invoice, [
  {
    name: "books an invoice below the threshold without asking anyone",
    input,
    mocks: { "match-po": { amount: 800_000 }, extract: { total: 400_000, currency: "EUR" }, book: "ledger-7" },
    expect: { output: { status: "booked", entry: "ledger-7" } },
  },
  {
    name: "doesn't book an invoice the reviewer rejects",
    input,
    mocks: { "match-po": { amount: 800_000 }, extract: { total: 800_000, currency: "EUR" } },
    decisions: { review: { approved: false, by: "anna" } },
    expect: { output: { status: "rejected" }, sideEffects: [{ name: "review#ask", input: { from: "role:admin", reminder: false } }] },
  },
]);
`;

/**
 * A step that calls Outlook: connections don't exist in connect yet, so
 * `reached` is a call that passed every check on its way.
 */
const mailStep = (
  name: string
) => `  await step.do("${name}", { description: "Read mail" }, async () => {
    try {
      await env.OUTLOOK.call("mail.list", {});
      return "sent";
    } catch (error) {
      if ((error as { code?: string }).code === "connect.connection_not_found") {
        return "reached";
      }
      throw error;
    }
  });`;

/**
 * Where core's record has a run now, as the App's run list shows it: unlike
 * a run's status, the list never asks the engine.
 */
const listedStatus = async (
  person: Person,
  app: string,
  run: string
): Promise<string | undefined> => {
  const runs = await person.api.workflows.list(app);
  return runs.find(({ id }) => id === run)?.status;
};

/** A run a trigger started, which acts for the App's owner. */
const triggered = async (app: string, workflow: string) =>
  await startRun(env, {
    app: appIdSchema.parse(app),
    workflow: workflowIdSchema.parse(workflow),
    input: undefined,
    startedBy: null,
    actor: { type: "system" },
  });

/** A workflow `pinned` that waits, then says which version it is. */
const versioned = (label: number) =>
  workflowFiles(
    "pinned",
    `  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return { version: ${label} };`
  );

describe("workflow runs", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("run the sample invoice workflow end to end, and audit it", async () => {
    const builder = await personApi("builder");
    const reviewer = await personApi("admin");
    const app = await appWith(builder, {
      ...modelRegistration({ extractor: 6000 }),
      "workflows/invoice-approval.ts": invoiceWorkflow,
      "workflows/invoice-approval.workflow-tests.ts": invoiceTests,
    });
    // An admin binds the model its AI step goes through.
    await bindModel(app, "extractor", extractionModel);
    // The model reads the invoice's total.
    const gateway = fakeGateway({
      text: JSON.stringify({ total: 800_000, currency: "EUR" }),
      inputTokens: 10,
      outputTokens: 5,
    });
    const ai: AiBinding = env.AI;
    const answering = vi
      .spyOn(ai, "fetch")
      .mockImplementation(gateway.binding.fetch);
    const invoice = {
      number: "INV-7",
      purchaseOrder: "PO-1",
      text: "Total 8,000 EUR",
    };
    const run = await builder.api.workflows.start(
      app,
      "invoice-approval",
      invoice
    );
    // An admin, as the reviewer parameter says, approves.
    const decision = await vi.waitFor(
      async () => {
        const opened = await env.DB.prepare(
          "SELECT id FROM workflow_decisions WHERE run_id = ?"
        )
          .bind(run.id)
          .first<{ id: string }>();
        if (!opened) {
          throw new Error("No decision yet");
        }
        return opened.id;
      },
      { timeout: 10_000 }
    );
    answering.mockRestore();
    await confirmedAnswer(reviewer, decision, { approved: true });
    await finished(run.id);
    const logged = await allEvents();
    const audited = logged.filter(({ target }) => target?.id === run.id);

    expect({
      matched: await runObject(run.id).stepOutput({
        name: "match-po",
        count: 1,
      }),
      status: await builder.api.workflows.status(run.id),
      runs: await builder.api.workflows.list(app),
      audited: audited
        .map(({ action, detail }) => `${action} ${detail.step ?? ""}`.trim())
        .toSorted(),
      auditedFor: new Set(
        audited.map(({ detail }) => `${detail.app}/${detail.version}`)
      ),
      asked: gateway.requests.map(({ body }) => body),
    }).toMatchObject({
      matched: { kind: "value", value: { amount: 800_000 } },
      status: {
        status: "completed",
        version: 1,
        workflow: "invoice-approval",
        output: {
          status: "booked",
          entry: `ledger-INV-7-for-${builder.userId}`,
        },
      },
      runs: [{ id: run.id, status: "completed" }],
      audited: [
        "workflow.run.completed",
        "workflow.run.started",
        "workflow.step.completed $params",
        "workflow.step.completed book",
        "workflow.step.completed extract",
        "workflow.step.completed match-po",
        "workflow.step.completed review",
        "workflow.step.completed review#ask",
        "workflow.step.completed review#asked",
      ],
      auditedFor: new Set([`${app}/1`]),
      // Half the binding's 6,000 tokens, as the step may ask again. The
      // binding holds the whole bound to what Llama 3.3 can answer, a
      // quarter of its window, as an action would ask for all of it.
      asked: [{ max_completion_tokens: 3000 }],
    });
  });

  it("refuse binding a model that can't give the declared bound, though only an AI step uses it", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, {
      ...modelRegistration({ extractor: 6001 }),
      "workflows/invoice-approval.ts": invoiceWorkflow,
      "workflows/invoice-approval.workflow-tests.ts": invoiceTests,
    });
    await expect(
      bindModel(app, "extractor", extractionModel)
    ).rejects.toMatchObject({
      code: "resource.model_too_small",
      details: { maxTokens: 6001, usableTokens: 6000 },
    });
  });

  it("keep the version they started on after a new one is current", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, versioned(1));
    const first = await builder.api.workflows.start(app, "pinned");
    await stepDone(first.id, "$params");
    await stopped(first.id);

    await release(builder, app, versioned(2));
    const second = await builder.api.workflows.start(app, "pinned");
    // The first run loads again only now, with version 2 current.
    const outputs = await Promise.all(
      [first, second].map(async ({ id }) => {
        await woken(id);
        await finished(id);
        return await builder.api.workflows.status(id);
      })
    );
    expect(outputs).toMatchObject([
      { version: 1, status: "completed", output: { version: 1 } },
      { version: 2, status: "completed", output: { version: 2 } },
    ]);
  });

  it("fail the next step of a run on a version no admin approved, whatever is granted again for another", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const version = (mark: string) =>
      workflowFiles(
        "mailer",
        `  // ${mark}
  await step.sleep("go", { description: "Wait", duration: "1 day" });
${mailStep("after")}`,
        { after: "reached" }
      );
    const app = await appWith(builder, version("First."));
    const permission = await requestGranted(idp, builder, outlook(app));
    // The attack: the builder's own code, which an admin's run starts on
    // and waits in; then harmless code, which an admin grants again for.
    await release(builder, app, version("Mails whatever it likes."));
    const run = await admin.api.workflows.start(app, "mailer");
    await stepDone(run.id, "$params");
    await stopped(run.id);
    await release(builder, app, version("Harmless."));
    await grantReviewed(admin.api, permission);

    await woken(run.id);
    await finished(run.id);
    // A run on the version the admin granted for works.
    const approved = await admin.api.workflows.start(app, "mailer");
    await woken(approved.id);
    await finished(approved.id);
    const events = await allEvents();
    const failedStep = events.find(
      ({ action, target }) =>
        action === "workflow.step.failed" && target?.id === run.id
    );

    expect({
      attacked: await admin.api.workflows.status(run.id),
      failedStep: failedStep?.detail,
      approved: await admin.api.workflows.status(approved.id),
    }).toMatchObject({
      attacked: { version: 2, status: "failed" },
      failedStep: { step: "after", errorCode: "permission.denied" },
      approved: { version: 3, status: "completed" },
    });
  });

  // The v1 App server's methods and their bindings: they go with the
  // server (GRA-645); run-functions.test.ts holds a sealed function's run
  // to its approved version.
  it("refuse a run on a version no admin approved its App's server methods, which run the approved current one", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    // Server code that reads a collection for its caller, under a
    // permission that also lets it write there: one that changes things.
    const savingServer = `import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  async save(caller: unknown): Promise<unknown> {
    const page = await (this.env as any).NOTES.listDocuments(caller);
    return page.documents.length;
  }
}
`;
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Notes ${crypto.randomUUID().slice(0, 8)}`,
      access: "everyone",
    });
    const version = (mark: string) => ({
      "app/server.ts": savingServer,
      ...workflowFiles(
        "saver",
        `  // ${mark}
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return await step.do("save", { description: "Save", retries: { limit: 0 } }, async () => (await env.APP.call("save")) as Json);`,
        { save: 0 }
      ),
    });
    const { id: app } = await builder.api.apps.create({ name: "Saver" });
    await release(builder, app, version("First."));
    const permission = await requestGranted(idp, builder, {
      subject: { type: "app", appId: app },
      object: { type: "collection", collectionId },
      actions: ["read", "write"],
      binding: "NOTES",
    });
    // The run on the builder's own version waits; then harmless code is
    // made current, and an admin grants again for it.
    await release(builder, app, version("Rewrites every rule."));
    const run = await admin.api.workflows.start(app, "saver");
    await stepDone(run.id, "$params");
    await stopped(run.id);
    await release(builder, app, version("Harmless."));
    await grantReviewed(admin.api, permission);

    await woken(run.id);
    await finished(run.id);
    const approved = await admin.api.workflows.start(app, "saver");
    await woken(approved.id);
    await finished(approved.id);
    const events = await allEvents();

    expect({
      attacked: await admin.api.workflows.status(run.id),
      failedStep: events.find(
        ({ action, target }) =>
          action === "workflow.step.failed" && target?.id === run.id
      )?.detail,
      approved: await admin.api.workflows.status(approved.id),
    }).toMatchObject({
      attacked: { version: 2, status: "failed" },
      failedStep: { step: "save", errorCode: "permission.denied" },
      // The run on the version the admin granted for reads the collection.
      approved: { version: 3, status: "completed", output: 0 },
    });
  });

  it("fail the next step with a permission error once a permission is revoked mid-run", async () => {
    const admin = await personApi("admin");
    const app = await appWith(
      admin,
      workflowFiles(
        "mailer",
        `${mailStep("before")}
  await step.sleep("go", { description: "Wait", duration: "1 day" });
${mailStep("after")}`,
        { before: "reached", after: "reached" }
      )
    );
    const permission = await requestGranted(idp, admin, outlook(app));
    const run = await admin.api.workflows.start(app, "mailer");
    await stepDone(run.id, "before");
    await stopped(run.id);

    await admin.api.permissions.revoke(permission);
    await woken(run.id);
    await finished(run.id);
    const { status, error } = await admin.api.workflows.status(run.id);
    const events = await allEvents();
    const steps = events.flatMap(({ action, target, detail }) =>
      action.startsWith("workflow.step.") && target?.id === run.id
        ? [{ action, step: detail.step, errorCode: detail.errorCode }]
        : []
    );
    expect({
      status,
      clearError: error?.message.includes(
        "This workflow has no permission named OUTLOOK: it was never granted, or it was revoked."
      ),
      steps,
    }).toMatchObject({
      status: "failed",
      clearError: true,
      steps: [
        { action: "workflow.step.completed", step: "$params" },
        { action: "workflow.step.completed", step: "before" },
        {
          action: "workflow.step.failed",
          step: "after",
          errorCode: "permission.denied",
        },
      ],
    });
  });

  it("check a model's answer against the step's schema, formats included", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, {
      ...modelRegistration({ extractor: 6000 }),
      ...workflowFiles(
        "reader",
        `  return await step.llm("extract", {
    description: "Read the total",
    binding: "extractor",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int(), from: z.email(), on: z.iso.date() }),
    retries: { limit: 0 },
  });`,
        { extract: { total: 1234, from: "anna@example.com", on: "2026-09-26" } }
      ),
    });
    await bindModel(app, "extractor", extractionModel);
    const runWithAnswers = async (...texts: string[]) => {
      const gateway = fakeGateway(
        ...texts.map((text) => ({ text, inputTokens: 10, outputTokens: 5 }))
      );
      // The binding the gateway sends through; the provider answers fake.
      const ai: AiBinding = env.AI;
      const answering = vi
        .spyOn(ai, "fetch")
        .mockImplementation(gateway.binding.fetch);
      try {
        const run = await builder.api.workflows.start(app, "reader");
        await finished(run.id);
        return await builder.api.workflows.status(run.id);
      } finally {
        answering.mockRestore();
      }
    };
    // The gateway asks once more when an answer doesn't fit.
    const unfit = await runWithAnswers('{"total": "lots"}', '{"total": 12.34}');
    const fit = await runWithAnswers(
      '{"total": 1234, "from": "anna@example.com", "on": "2026-09-26"}'
    );
    expect({ unfit, fit }).toMatchObject({
      unfit: {
        status: "failed",
        error: {
          message:
            "The model's answer didn't match the expected shape, also when asked again.",
        },
      },
      fit: {
        status: "completed",
        output: { total: 1234, from: "anna@example.com", on: "2026-09-26" },
      },
    });
  });

  it("fail a triggered run once its App's owner has left, at its start or before its next step", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const app = await appWith(
      owner,
      workflowFiles(
        "triggered",
        `  await step.do("first", { description: "First" }, async () => await ${hitCall(`"first"`)});
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return await step.do("book", { description: "Book" }, async () => await ${hitCall(`"book"`)});`,
        { first: 1, book: 1 }
      )
    );

    // Gone while the run waits between two steps: the next one doesn't run.
    const midWay = await triggered(app, "triggered");
    await stepDone(midWay.id, "first");
    const rejoin = await leave(owner.userId);
    await woken(midWay.id);
    await finished(midWay.id);
    await rejoin();
    const booked = await hitsOf(owner, app, "book");

    // Offboarded by an admin before the run starts.
    await admin.api.members.remove(owner.userId);
    const atStart = await triggered(app, "triggered");
    await finished(atStart.id);

    const outcomes = await Promise.all(
      [midWay, atStart].map(async ({ id }) => {
        const { status, failure } = await admin.api.workflows.status(id);
        return { status, step: failure?.step, code: failure?.error.code };
      })
    );
    const failed = {
      step: null,
      status: "failed",
      code: "permission.person_inactive",
    };
    expect({ booked, outcomes }).toStrictEqual({
      booked: 0,
      outcomes: [failed, failed],
    });
  });

  it("fail a person's run once they have left, at its next load", async () => {
    const admin = await personApi("admin");
    const leaver = await personApi("builder");
    const app = await appWith(
      leaver,
      workflowFiles(
        "waiting",
        `  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return "went on";`
      )
    );
    const run = await leaver.api.workflows.start(app, "waiting");
    await stepDone(run.id, "$params");
    await stopped(run.id);
    // Offboarded by an admin, as in the product.
    await admin.api.members.remove(leaver.userId);
    await woken(run.id);
    await finished(run.id);
    const { status, error } = await admin.api.workflows.status(run.id);
    expect({
      status,
      personGone: error?.message.includes(
        "The person this acts for no longer has access to this deployment."
      ),
    }).toStrictEqual({ status: "failed", personGone: true });
  });

  it("run with only their App's permissions, no network, and reading in their App's restricted mode", async () => {
    const admin = await personApi("admin");
    const app = await appWith(
      admin,
      workflowFiles(
        "probe",
        `  return await step.do("probe", { description: "Probe" }, async () => {
    let fetched;
    try {
      await fetch("https://example.com/");
      fetched = "fetched";
    } catch (error) {
      fetched = String(error);
    }
    let read;
    try {
      await env.OUTLOOK.call("mail.list", {});
      read = "ok";
    } catch (error) {
      read = (error as { code?: string }).code;
    }
    let other;
    try {
      await env.DRIVE.call("files.list", {});
      other = "ok";
    } catch (error) {
      other = (error as { code?: string }).code;
    }
    return { fetched, read, other };
  });`,
        { probe: null }
      )
    );
    await requestGranted(idp, admin, outlook(app));
    await appHost(env, appIdSchema.parse(app)).restrict();
    const run = await admin.api.workflows.start(app, "probe");
    await finished(run.id);
    const { status, output } = await admin.api.workflows.status(run.id);
    expect({
      status,
      output,
      offline: JSON.stringify(output).includes(
        "not permitted to access the internet"
      ),
    }).toMatchObject({
      status: "completed",
      // A read still reaches connect (there is no such connection). Side
      // effects wait for the person (the tests of held side effects).
      output: {
        read: "connect.connection_not_found",
        // Only what it was granted: a binding it wasn't is none.
        other: "permission.denied",
      },
      offline: true,
    });
  });

  it("build their bindings before the workflow's code loads, so a built-in it replaces is handed none of them", async () => {
    const admin = await personApi("admin");
    const files = workflowFiles(
      "taker",
      `  return await step.do("take", { description: "Take" }, async () => {
    const bindings = taken.find((one) => typeof one?.APP?.callFunction === "function");
    if (bindings !== undefined) {
      await bindings.APP?.callFunction?.({ contractId: "counter.hit", kind: "action" }, { name: "taken", execution: crypto.randomUUID() });
    }
    return bindings === undefined ? "nothing" : "bindings";
  });`,
      { take: null }
    );
    // As the module loads, it puts its own in place of what a run's
    // bindings could be built with, each keeping what it is handed: no
    // `env` anywhere in its code.
    const takes = `const taken: { APP?: { callFunction?: (...args: object[]) => Promise<unknown> } }[] = [];
const RealProxy = globalThis.Proxy;
// Past the types, as a module that takes what it is handed would be.
globalThis.Proxy = function (target: object, handler: ProxyHandler<object>) {
  taken.push(target);
  return new RealProxy(target, handler);
} as unknown as ProxyConstructor;
const realFromEntries = Object.fromEntries;
Object.fromEntries = (entries: Iterable<readonly [PropertyKey, unknown]>) => {
  const made = realFromEntries(entries);
  taken.push(made);
  return made;
};
const realHasOwn = Object.hasOwn;
Object.hasOwn = (target: object, name: PropertyKey) => {
  taken.push(target);
  return realHasOwn(target, name);
};
`;
    const app = await appWith(admin, {
      ...files,
      "workflows/taker.ts": `${takes}${files["workflows/taker.ts"]}`,
    });

    const run = await admin.api.workflows.start(app, "taker");
    await finished(run.id);

    const { status, output } = await admin.api.workflows.status(run.id);
    expect({
      status,
      output,
      hits: await hitsOf(admin, app, "taken"),
    }).toStrictEqual({ status: "completed", output: "nothing", hits: 0 });
  });

  it("sleep durably", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "sleeper",
        `  await step.sleep("nap", { description: "Wait a day", duration: "1 day" });
  return "slept";`
      )
    );
    const run = await builder.api.workflows.start(app, "sleeper");
    await woken(run.id, "nap");
    await finished(run.id);
    const { status, output } = await builder.api.workflows.status(run.id);
    expect({ status, output }).toStrictEqual({
      status: "completed",
      output: "slept",
    });
  });

  it("can't be made current while their tests fail or are missing", async () => {
    const builder = await personApi("builder");
    const { id: app } = await builder.api.apps.create({ name: "Untested" });
    const failing = workflowFiles("failing", `  return 1;`);
    failing["workflows/failing.workflow-tests.ts"] =
      `import { workflowTests } from "@grasp-os/sdk/testing";
import definition from "./failing.ts";
export default workflowTests(definition, [{ name: "returns two", expect: { output: 2 } }]);
`;
    const setCurrent = async (files: Record<string, string | null>) => {
      const { version } = await builder.api.apps.files.commit(
        app,
        files,
        "Try"
      );
      return await refusal(builder.api.apps.versions.setCurrent(app, version));
    };
    const outcomes = [
      await setCurrent({ ...sampleApp(), ...failing }),
      await setCurrent({ "workflows/failing.workflow-tests.ts": null }),
    ];
    expect(
      outcomes.map((outcome) => workflowErrors.codeOf(outcome))
    ).toStrictEqual(["workflow.tests_failed", "workflow.tests_failed"]);
    await expect(builder.api.apps.get(app)).resolves.toMatchObject({
      currentVersion: null,
    });
  });

  it("take shared code from a folder under workflows/, and say which files are workflows", async () => {
    const builder = await personApi("builder");
    const { id: app } = await builder.api.apps.create({ name: "Shared" });
    const helper = `export const greeting = (name: string) => \`Hello, \${name}\`;\n`;
    const greet = workflowFiles("greet", `  return greeting("Anna");`);
    const importing = (from: string) =>
      `import { greeting } from "${from}";\n${greet["workflows/greet.ts"]}`;
    const setCurrent = async (files: Record<string, string | null>) => {
      const { version } = await builder.api.apps.files.commit(
        app,
        files,
        "Try"
      );
      return await refusal(builder.api.apps.versions.setCurrent(app, version));
    };

    const directly = await setCurrent({
      ...sampleApp(),
      ...greet,
      "workflows/greet.ts": importing("./greeting.ts"),
      "workflows/greeting.ts": helper,
    });
    const inFolder = await setCurrent({
      "workflows/greet.ts": importing("./lib/greeting.ts"),
      "workflows/greeting.ts": null,
      "workflows/lib/greeting.ts": helper,
    });
    const run = await builder.api.workflows.start(app, "greet");
    await finished(run.id);

    expect({
      directly: z
        .object({ details: z.object({ failures: z.array(z.string()) }) })
        .parse(directly).details.failures,
      inFolder,
      run: await builder.api.workflows.status(run.id),
    }).toMatchObject({
      directly: [
        "greeting: has no tests (workflows/greeting.workflow-tests.ts). Only `workflows/<id>.ts` (an id without dots) is a workflow: put shared code in a folder under workflows/, such as workflows/lib/.",
      ],
      inFolder: "ok",
      run: { status: "completed", output: "Hello, Anna" },
    });
  });

  it("can't replay core's steps or take ones the engine refuses, and audit every step with only well-formed error codes", async () => {
    const admin = await personApi("admin");
    // Written by hand, past the SDK: the host is the boundary, not the SDK.
    const rogue = {
      "workflows/rogue.ts": `import type { WorkflowDefinition } from "@grasp-os/sdk/workflow";

// Past the SDK: the engine as the host hands it to a run's code.
type Engine = {
  do: <T>(name: string, options: object, fn: () => Promise<T>) => Promise<T>;
};

export default {
  metadata: { id: "rogue", params: [] },
  run: async (engine: Engine) => {
    await engine.do("$sneaky", {}, async () => "sneaked");
    // Steps the engine would refuse, which it fails the whole run for:
    // caught here, they must fail no more than their step.
    try {
      await engine.do("bell\u0007", {}, async () => null);
    } catch {}
    try {
      await engine.do("huge", { retries: { limit: 0 } }, async () => "x".repeat(1_100_000));
    } catch {}
    let hijack = "ran";
    try {
      await engine.do("$grasp:end", {}, async () => null);
    } catch (error) {
      hijack = String((error as { code?: string }).code);
    }
    try {
      await engine.do("failing", { retries: { limit: 0 } }, async () => {
        throw Object.assign(new Error("no"), { code: "x".repeat(300) });
      });
    } catch {}
    throw Object.assign(new Error("bad: " + hijack), {
      code: "Invoice for Anna de Vries",
      name: "n".repeat(300),
    });
  },
} as unknown as WorkflowDefinition<never>;
`,
      "workflows/rogue.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";
import definition from "./rogue.ts";
export default workflowTests(definition, [{ name: "fails", expect: { error: "bad" } }]);
`,
    };
    const app = await appWith(admin, rogue);
    const run = await admin.api.workflows.start(app, "rogue");
    await finished(run.id);
    const logged = await allEvents();
    const events = logged.filter(({ target }) => target?.id === run.id);
    const { status, error, failure } = await admin.api.workflows.status(run.id);
    expect({
      status,
      row: await listedStatus(admin, app, run.id),
      hijack: error?.message.includes("bad: workflow.invalid"),
      // It failed after the step it caught, outside any step.
      failure: { step: failure?.step, code: failure?.error.code },
      audited: events
        .filter(({ action }) => action !== "workflow.run.started")
        .map(({ action, detail }) =>
          [action, detail.step ?? "", detail.errorCode ?? detail.error ?? ""]
            .join(" ")
            .trim()
        )
        .toSorted(),
    }).toStrictEqual({
      status: "failed",
      row: "failed",
      hijack: true,
      failure: { step: null, code: "workflow.run_failed" },
      audited: [
        "workflow.run.failed  workflow.run_failed",
        "workflow.run.notified",
        "workflow.step.completed $sneaky",
        "workflow.step.failed failing workflow.step_failed",
        "workflow.step.failed huge workflow.step_failed",
      ],
    });
  });

  it("stop for good when cancelled, running or paused, and not run a cancelled row again", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "cancellable",
        `  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return await step.do("after", { description: "After" }, async () => await ${hitCall(`"after"`)});`,
        { after: 1 }
      )
    );
    const waiting = await builder.api.workflows.start(app, "cancellable");
    const paused = await builder.api.workflows.start(app, "cancellable");
    await stepDone(paused.id, "$params");
    await stopped(paused.id);
    const cancelled = await Promise.all(
      [waiting, paused].map(
        async ({ id }) => await builder.api.workflows.cancel(id)
      )
    );

    // A cancel whose termination failed: the row has its tombstone, and
    // the engine's run goes on. Its next activation does nothing more, and
    // the row says cancelled once the engine has ended it.
    const leftOver = await builder.api.workflows.start(app, "cancellable");
    // Stopped once it waits, so its next activation reads the row this
    // test marks cancelled.
    await stepDone(leftOver.id, "$params");
    await stopped(leftOver.id);
    await env.DB.prepare(
      "UPDATE workflow_runs SET cancel_requested_at = ? WHERE id = ?"
    )
      .bind(Date.now(), leftOver.id)
      .run();
    await woken(leftOver.id);
    await finished(leftOver.id);
    const afterLoad = await liveStatus(leftOver.id);
    const leftOverRow = await vi.waitFor(
      async () => {
        const { status } = await builder.api.workflows.status(leftOver.id);
        expect(status).toBe("cancelled");
        return status;
      },
      { timeout: 10_000, interval: 100 }
    );

    // A cancel that raced a start that failed: the engine has no instance
    // to terminate. A cancel of the row still running marks and audits it,
    // and one of the row already cancelled is done.
    const withoutInstance = async (
      status: "running" | "cancelled"
    ): Promise<string> => {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at)
         SELECT ?, app_id, workflow_id, version, started_by, ?, created_at
         FROM workflow_runs WHERE id = ?`
      )
        .bind(id, status, leftOver.id)
        .run();
      return id;
    };
    const neverRunning = await withoutInstance("running");
    const neverCancelled = await withoutInstance("cancelled");
    const raced = await Promise.all(
      [neverRunning, neverCancelled].map(async (id) => {
        const { status } = await builder.api.workflows.cancel(id);
        return status;
      })
    );

    const events = await allEvents();
    expect({
      cancelled: cancelled.map(({ status }) => status),
      live: await Promise.all(
        [waiting, paused].map(async ({ id }) => await liveStatus(id))
      ),
      audited: events.filter(
        ({ action, target }) =>
          action === "workflow.run.cancelled" &&
          (target?.id === waiting.id || target?.id === paused.id)
      ).length,
      afterLoad,
      leftOverRow,
      after: await hitsOf(builder, app, "after"),
      raced,
      racedAudited: events.filter(
        ({ action, target }) =>
          action === "workflow.run.cancelled" && target?.id === neverRunning
      ).length,
    }).toStrictEqual({
      cancelled: ["cancelled", "cancelled"],
      live: ["terminated", "terminated"],
      audited: 2,
      afterLoad: "errored",
      leftOverRow: "cancelled",
      after: 0,
      raced: ["cancelled", "cancelled"],
      racedAudited: 1,
    });
  });

  it("audit a run whose start failed as failed", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "unstartable",
        `  return await step.do("work", { description: "Work" }, async () => null);`,
        { work: null }
      )
    );
    // An ID core's record takes but Workflows refuses (over 100
    // characters), so creating the run fails after its row is written.
    const taken: ReturnType<typeof crypto.randomUUID> =
      `run-${"x".repeat(100)}-${crypto.randomUUID()}`;
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(taken);
    let refused: unknown;
    try {
      refused = await refusal(triggered(app, "unstartable"));
    } finally {
      uuid.mockRestore();
    }
    const { status, failure } = await builder.api.workflows.status(taken);
    expect({
      refused: refused !== "ok",
      row: await listedStatus(builder, app, taken),
      status,
      failure: failure && {
        step: failure.step,
        input: failure.input,
        error: failure.error,
      },
      audited: await runEvents(taken, "workflow.run.failed"),
    }).toStrictEqual({
      refused: true,
      row: "failed",
      status: "failed",
      // A report its owner sees, saying only that it didn't start.
      failure: {
        step: null,
        input: null,
        error: {
          code: "workflow.run_failed",
          message: "The workflow run couldn't be started.",
        },
      },
      audited: [
        "workflow.run.failed start_failed workflow.run_failed",
        "workflow.run.notified",
        "workflow.run.started",
      ],
    });
  });

  it("show what a run returned only to the person who started it, and admins", async () => {
    const starter = await personApi("builder");
    const other = await personApi("builder");
    const admin = await personApi("admin");
    const app = await appWith(
      starter,
      workflowFiles(
        "private",
        `  return await step.do("read", { description: "Read" }, async () => "what the starter may read");`,
        { read: "x" }
      )
    );
    await starter.api.apps.members.add(app, {
      type: "person",
      id: other.userId,
      role: "user",
    });
    const run = await starter.api.workflows.start(app, "private");
    await finished(run.id);
    const seen = await Promise.all(
      [starter, other, admin].map(async ({ api }) => {
        const { status, output } = await api.workflows.status(run.id);
        return { status, output };
      })
    );
    expect(seen).toStrictEqual([
      { status: "completed", output: "what the starter may read" },
      { status: "completed", output: undefined },
      { status: "completed", output: "what the starter may read" },
    ]);
  });
});

/** Workflow code that sends the invoice mail with idempotency key `key`. */
const sendWith = (key: string) =>
  `await env.MAIL.call("mail.send", ${JSON.stringify(invoiceMail)}, { idempotencyKey: ${key} })`;

describe("workflow side effects and failures", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("take a connection call only inside a step, and with the step's own key", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    // Calls between steps can't be read as a step's, so the workflow that
    // makes them is held to none: they are refused as outside a step
    // first. The one that makes its calls in its step is held to them.
    const app = await appWith(admin, {
      ...workflowFiles(
        "outside",
        `  const codeOf = async (key: string) => {
    try {
      ${sendWith("key")};
      return "sent";
    } catch (error) {
      return (error as { code?: string }).code;
    }
  };
  const outside = await codeOf("keys-outside");
  // A step whose last attempt hangs: once it has settled, calls between
  // steps are refused again.
  try {
    await step.do("hang", { description: "Hang", timeout: "1 second", retries: { limit: 0 } }, async () => {
      await new Promise(() => {});
    });
  } catch {}
  const afterHang = await codeOf("keys-after-hang");
  return { outside, afterHang };`,
        { hang: null }
      ),
      ...workflowFiles(
        "keys",
        `  return await step.do(
    "send",
    { description: "Send the invoice", sideEffect: true, input: null },
    async ({ idempotencyKey }) => {
      // A key of each attempt's own would send once per attempt.
      let perAttempt = "sent";
      try {
        ${sendWith('idempotencyKey + ":attempt-2"')};
      } catch (error) {
        perAttempt = String((error as { code?: string }).code);
      }
      // A constant key would answer every run with the first run's mail.
      let constant = "sent";
      try {
        ${sendWith('"invoice-INV-7"')};
      } catch (error) {
        constant = String((error as { code?: string }).code);
      }
      return { perAttempt, constant };
    }
  );`,
        { send: {} }
      ),
    });
    await grantMail(idp, admin, app, mail.id);
    const outside = await admin.api.workflows.start(app, "outside");
    const keys = await admin.api.workflows.start(app, "keys");
    await Promise.all([finished(outside.id), finished(keys.id)]);

    expect({
      outside: await admin.api.workflows.status(outside.id),
      keys: await admin.api.workflows.status(keys.id),
      server: await mail.did(),
    }).toMatchObject({
      outside: {
        status: "completed",
        output: {
          outside: "workflow.outside_step",
          afterHang: "workflow.outside_step",
        },
      },
      keys: {
        status: "completed",
        output: {
          perAttempt: "workflow.idempotency_key_invalid",
          constant: "workflow.idempotency_key_invalid",
        },
      },
      server: { calls: 0, sent: [] },
    });
  });

  it("stop at a call the server answered with an error without retrying it, with a report for the run's owner", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const starter = await personApi("builder");
    const mail = await mailConnection(["invalid", "invalid"]);
    const app = await appWith(
      owner,
      mailer(`retries: { limit: 3, delay: 10, backoff: "constant" }`)
    );
    await grantMail(idp, owner, app, mail.id);
    await owner.api.apps.members.add(app, {
      type: "person",
      id: starter.userId,
      role: "user",
    });
    // One run a person started, which acts for them; one a trigger
    // started, which acts for the App's owner.
    const started = await starter.api.workflows.start(app, "mailer");
    const byTrigger = await triggered(app, "mailer");
    await Promise.all([finished(started.id), finished(byTrigger.id)]);
    const failures = async (person: Person) => {
      const runs = await person.api.workflows.list(app);
      const failureOf = (id: string) =>
        runs.find((run) => run.id === id)?.failure?.run ?? null;
      const { failure } = await person.api.workflows.status(started.id);
      return {
        status: failure?.run,
        listed: [failureOf(started.id), failureOf(byTrigger.id)],
      };
    };
    const unknownApp = await refusal(
      starter.api.workflows.list(crypto.randomUUID())
    );
    const logged = await allEvents();
    const events = logged.filter(
      ({ action, target }) =>
        action === "workflow.run.failed" && target?.id === started.id
    );

    const seen = {
      starter: await failures(starter),
      owner: await failures(owner),
      admin: await failures(admin),
    };
    // A triggered run's report goes with its App: once someone else owns
    // it, they see it, and the old owner no longer does.
    await env.DB.prepare("UPDATE apps SET owner_id = ? WHERE id = ?")
      .bind(starter.userId, app)
      .run();
    // Still sharing it, now as a user.
    await starter.api.apps.members.add(app, {
      type: "person",
      id: owner.userId,
      role: "user",
    });
    const { listed: starterLists } = await failures(starter);
    const { listed: ownerLists } = await failures(owner);
    const afterOwnerChange = { starter: starterLists, owner: ownerLists };

    expect({
      server: await mail.did(),
      report: await admin.api.workflows.status(started.id),
      seen,
      afterOwnerChange,
      audited: events.map(({ detail }) => detail.error),
      unknownApp: appErrors.codeOf(unknownApp),
    }).toMatchObject({
      // One call each, never retried: the tool may have acted.
      server: { calls: 2, sent: [] },
      report: {
        status: "failed",
        failure: {
          run: started.id,
          app,
          workflow: "mailer",
          version: 1,
          step: "send",
          // What the step works on, without the values.
          input: { to: "string", subject: "string" },
          // On Composio a tool's error can't be told from one after it
          // acted: unknown, never sent again.
          error: { code: "connect.outcome_unknown" },
        },
      },
      seen: {
        starter: { status: started.id, listed: [started.id, null] },
        owner: { status: undefined, listed: [null, byTrigger.id] },
        admin: { status: started.id, listed: [started.id, byTrigger.id] },
      },
      afterOwnerChange: {
        starter: [started.id, byTrigger.id],
        owner: [null, null],
      },
      audited: ["connect.outcome_unknown"],
      unknownApp: "app.not_found",
    });
  });

  it("stop at an error of the workflow's own without retrying it, reporting its input's shape but none of its data", async () => {
    const admin = await personApi("admin");
    const app = await appWith(
      admin,
      workflowFiles(
        "careless",
        `  await step.do(
    "check",
    {
      description: "Check the customer",
      input: { customer: "c-1", "anna@example.com": true, "INV-2026-0007": 1, lines: [1, 2], note: null },
      retries: { limit: 3, delay: 10 },
    },
    async () => {
      await ${hitCall(`"check"`)};
      throw new Error("Customer c-1 is blocked");
    }
  );`,
        { check: null }
      )
    );
    const run = await admin.api.workflows.start(app, "careless");
    await finished(run.id);

    const { failure } = await admin.api.workflows.status(run.id);
    expect({
      failure,
      attempts: await hitsOf(admin, app, "check"),
    }).toMatchObject({
      failure: {
        step: "check",
        // No values; no field whose name could be data (an address, an ID).
        input: {
          customer: "string",
          lines: "array",
          note: "null",
          "…": "2 more",
        },
        error: {
          code: "workflow.run_failed",
          message: "Customer c-1 is blocked",
        },
      },
      attempts: 1,
    });
  });

  it("fail, recorded and reported, once a run has taken as many steps as it may", async () => {
    const admin = await personApi("admin");
    // More steps than the engine takes in one execution (vite.config.ts).
    const app = await appWith(
      admin,
      workflowFiles(
        "endless",
        `  for (let i = 0; i < 100; i++) {
    await step.do("step-" + i, { description: "One more" }, async () => i);
  }`
      )
    );
    const run = await admin.api.workflows.start(app, "endless");
    await finished(run.id);

    const { status, failure } = await admin.api.workflows.status(run.id);
    expect({
      status,
      row: await listedStatus(admin, app, run.id),
      failure: failure?.error.code,
    }).toStrictEqual({
      status: "failed",
      row: "failed",
      failure: "workflow.too_many_steps",
    });
  });
});
