import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { setCurrentVersion } from "../src/apps.ts";
import { fakeGateway, loggedRunStep } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import { confirmedAnswer } from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns, finished, runObject } from "./runs.ts";
import { refusal, signedInApi } from "./sign-in.ts";
import {
  appCall,
  appWith,
  bindModel,
  modelRegistration,
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
//
// These are the runs of workflows with AI steps, and the models they go
// through (the rest of workflows.test.ts).

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

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

/** A workflow whose one AI step goes through the App's `binding`. */
const reading = (binding: string): Record<string, string> =>
  workflowFiles(
    "reader",
    `  return await step.llm("extract", {
    description: "Read the total",
    binding: "${binding}",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
  });`,
    { extract: { total: 1234 } }
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

  it("refuse to make a version current whose AI steps go through anything but a text model it declares, naming each step", async () => {
    const builder = await personApi("builder");
    const { id: app } = await builder.api.apps.create({ name: "Invoices" });
    // A text model, and one with a structured output, beside the sample
    // App's connector and statistics resources.
    const registration = modelRegistration({ extractor: 6000 });
    const appTs = (registration["app.ts"] ?? "")
      .replace(
        'import { app, resource } from "@grasp-os/sdk";',
        'import { app, resource, v } from "@grasp-os/sdk";\n\nexport const shaped = resource.model("shaped", { maxOutputTokens: 100, structuredOutput: v.object({ total: v.number() }) });'
      )
      .replace(", extractor]", ", extractor, shaped]");
    const activating = async (
      files: Record<string, string>,
      to = app
    ): Promise<{ code: string; steps: string[] }> => {
      const { version } = await builder.api.apps.files.commit(to, files, "Try");
      const outcome = await refusal(
        builder.api.apps.versions.setCurrent(to, version)
      );
      const refused = z
        .object({
          code: z.string(),
          details: z.object({
            diagnostics: z.array(
              z.object({
                file: z.string(),
                line: z.number(),
                message: z.string(),
              })
            ),
          }),
        })
        .safeParse(outcome);
      return refused.success
        ? {
            code: refused.data.code,
            steps: refused.data.details.diagnostics.map(
              ({ file, line, message }) =>
                `${file}:${line} ${message.split(",")[0] ?? ""}`
            ),
          }
        : { code: String(outcome), steps: [] };
    };
    const own = { ...registration, "app.ts": appTs };
    // One after the other: each commit is the App's next version.
    const undeclared = await activating({ ...own, ...reading("missing") });
    const connector = await activating({ ...own, ...reading("send") });
    const structured = await activating({ ...own, ...reading("shaped") });
    // A step its outline can't read (in a \`try\`) runs all the same, and
    // one taken through \`step\` passed on goes through a model no one can
    // read.
    const tried = await activating({
      ...own,
      ...workflowFiles(
        "reader",
        `  try {
    return await step.llm("extract", {
      description: "Read the total",
      binding: "missing",
      instructions: "Read the total in cents.",
      input: "Total 12.34 EUR",
      schema: z.object({ total: z.int() }),
    });
  } catch {
    return null;
  }`,
        { extract: { total: 1234 } }
      ),
    });
    const passed = await activating({
      ...own,
      ...workflowFiles(
        "reader",
        `  const ask = step;
  return await ask.do("extract", { description: "Read the total" }, async () => 1);`,
        { extract: 1 }
      ),
    });
    // Options that may replace the binding can't be read either; a
    // workflow whose context can't be read (\`env\` kept outside a step)
    // is still read by its runner.
    const spread = await activating({
      ...own,
      ...workflowFiles(
        "reader",
        `  return await step.llm("extract", {
    description: "Read the total",
    binding: "extractor",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
    ...{ binding: "missing" },
  });`,
        { extract: { total: 1234 } }
      ),
    });
    const unreadable = await activating({
      ...own,
      ...workflowFiles(
        "reader",
        `  const kept = env.MAIL;
  return await step.llm("extract", {
    description: "Read the total",
    binding: "missing",
    instructions: String(kept),
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
  });`,
        { extract: { total: 1234 } }
      ),
    });
    // Text isn't a call: an unreadable workflow that only mentions one.
    const mentioned = await activating({
      ...own,
      ...workflowFiles(
        "reader",
        `  const kept = env.MAIL; // no llm here
  return await step.do("extract", { description: "Count", input: { kept: String(kept) } }, async () => 1);`,
        { extract: 1 }
      ),
    });
    // Another variable named \`step\` is just that.
    const shadowed = await activating({
      ...own,
      ...workflowFiles(
        "reader",
        `  const labels = ["a"].map((step) => step.length);
  return await step.do("extract", { description: "Count", input: { labels } }, async () => 1);`,
        { extract: 1 }
      ),
    });
    const fits = await activating({ ...own, ...reading("extractor") });
    // An App of the earlier layout declares no resources at all.
    const { id: earlier } = await builder.api.apps.create({ name: "Earlier" });
    const unsealed = await activating(reading("extractor"), earlier);
    // Sealed by a refused activation, then made current without sealing:
    // its candidate is verified the same way, models included.
    const { version: again } = await builder.api.apps.files.commit(
      app,
      { ...own, ...reading("missing"), "AGENTS.md": "# Again\n" },
      "Again"
    );
    await refusal(builder.api.apps.versions.setCurrent(app, again));
    const unsealedPath = z
      .object({ code: z.string() })
      .parse(
        await refusal(
          setCurrentVersion(env, await builder.api.whoami(), app, again)
        )
      ).code;
    const step =
      'workflows/reader.ts:4 AI step "extract" of workflow "reader" goes through';
    expect({
      undeclared,
      connector,
      structured,
      tried,
      passed,
      spread,
      unreadable,
      mentioned,
      shadowed,
      fits,
      unsealed,
      unsealedPath,
    }).toStrictEqual({
      undeclared: {
        code: "workflow.model_undeclared",
        steps: [`${step} "missing"`],
      },
      connector: {
        code: "workflow.model_undeclared",
        steps: [`${step} "send"`],
      },
      structured: {
        code: "workflow.model_undeclared",
        steps: [`${step} "shaped"`],
      },
      tried: {
        code: "workflow.model_undeclared",
        steps: [`${step} "missing"`.replace(":4 ", ":5 ")],
      },
      passed: {
        code: "workflow.model_undeclared",
        steps: [
          'workflows/reader.ts:4 An AI step of workflow "reader" goes through a model that can\'t be read: call it as `step.llm("name"',
        ],
      },
      spread: {
        code: "workflow.model_undeclared",
        steps: [
          'workflows/reader.ts:4 AI step "extract" of workflow "reader" goes through a model that can\'t be read: call it as `step.llm("name"',
        ],
      },
      unreadable: {
        code: "workflow.model_undeclared",
        steps: [
          'workflows/reader.ts:5 AI step "extract" of workflow "reader" goes through "missing"',
        ],
      },
      mentioned: { code: "ok", steps: [] },
      shadowed: { code: "ok", steps: [] },
      fits: { code: "ok", steps: [] },
      unsealed: {
        code: "workflow.model_undeclared",
        steps: [`${step} "extractor"`],
      },
      unsealedPath: "workflow.model_undeclared",
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
        return {
          ...(await builder.api.workflows.status(run.id)),
          // Each request names its run and step in the gateway's log.
          logged: gateway.requests.map(loggedRunStep),
          expected: `${run.id}/extract`,
        };
      } finally {
        answering.mockRestore();
      }
    };
    // The gateway asks once more when an answer doesn't fit.
    const unfit = await runWithAnswers('{"total": "lots"}', '{"total": 12.34}');
    const fit = await runWithAnswers(
      '{"total": 1234, "from": "anna@example.com", "on": "2026-09-26"}'
    );
    expect({
      unfit: unfit.logged.map((logged) => logged === unfit.expected),
      fit: fit.logged.map((logged) => logged === fit.expected),
    }).toStrictEqual({ unfit: [true, true], fit: [true] });
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
});
