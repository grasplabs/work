import type { RunSummary } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { removedText, sweepRunDetails } from "../src/workflows/retention.ts";
import { projectStatus } from "../src/workflows/runs.ts";
import { approvalApp, confirmedAnswer, week } from "./decisions.ts";
import type { Person } from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns, finished } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// A run's summary, as an App's screens read it (summary.ts): one read, of
// one revision of the run, whose every change takes the next revision in
// its own write. What could go wrong, tried below: fields of different
// moments mixed, a change that leaves the revision as it was, waits lost
// while paused or kept once answered, an ended run still offering
// controls, controls offered to someone the host would refuse, a pending
// cancel hidden, and another App's run read.

const idp = mockIdp();

const personApi = async (role: "admin" | "builder" | "user") =>
  await signedInApi(idp, role);

/** The approval workflow's input: a decision any admin answers, for a week. */
const byAdmins = { from: "role:admin", timeout: week };

/** The run's summary once `check` holds of it, as `person` reads it. */
const summaryWhen = async (
  person: Person,
  app: string,
  run: string,
  check: (summary: RunSummary) => boolean
): Promise<RunSummary> =>
  await vi.waitFor(
    async () => {
      const summary = await person.api.screens.summary(app, run);
      if (!check(summary)) {
        throw new Error(`The run is ${summary.status}`);
      }
      return summary;
    },
    { timeout: 20_000, interval: 100 }
  );

/** What a summary says, without its times and IDs. */
const shape = ({
  status,
  waits,
  control,
  error,
}: RunSummary): Partial<RunSummary> => ({
  status,
  waits: waits.map(({ kind, name }) => ({ kind, name, expiresAt: 0 })),
  control,
  ...(error === undefined ? {} : { error }),
});

const none = {
  canPause: false,
  canResume: false,
  canCancel: false,
  pendingControl: null,
};

describe("a run's summary", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("say where a run is, what it waits for and what its builder may do, of one revision each, as it waits, is paused, is answered and ends", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const app = await approvalApp(builder);
    const { id: run } = await builder.api.screens.startRun(
      app,
      "approval",
      byAdmins
    );

    const waiting = await summaryWhen(
      builder,
      app,
      run,
      ({ status, waits }) => status === "waiting" && waits.length === 1
    );
    await builder.api.screens.control(app, run, "pause");
    const paused = await summaryWhen(
      builder,
      app,
      run,
      ({ status }) => status === "paused"
    );
    // Answered while paused: taken, and run once resumed.
    const decision = await vi.waitFor(async () => {
      const found = await env.DB.prepare(
        "SELECT id FROM workflow_decisions WHERE run_id = ?"
      )
        .bind(run)
        .first<{ id: string }>();
      if (found === null) {
        throw new Error("No decision yet");
      }
      return found.id;
    });
    await confirmedAnswer(admin, decision, { approved: true });
    const answered = await summaryWhen(
      builder,
      app,
      run,
      ({ waits }) => waits.length === 0
    );
    await builder.api.screens.control(app, run, "resume");
    await finished(run);
    const done = await summaryWhen(
      builder,
      app,
      run,
      ({ status }) => status === "completed"
    );

    expect({
      waiting: shape(waiting),
      paused: shape(paused),
      answered: shape(answered),
      done: shape(done),
      newer: [waiting, paused, answered, done].every(
        ({ revision }, index, all) =>
          index === 0 || revision > (all[index - 1]?.revision ?? Infinity)
      ),
      started: waiting.startedAt !== null && waiting.finishedAt === null,
      finished:
        done.finishedAt !== null && done.finishedAt >= (done.startedAt ?? 0),
      identity: [waiting, done].map(
        ({ runId, workflowId, workflowVersion }) => ({
          runId,
          workflowId,
          workflowVersion,
        })
      ),
    }).toStrictEqual({
      // The approval workflow asks whoever its input names, so its review
      // can't read its steps, and names none (a keyed decision of a
      // workflow its review reads is named, below).
      waiting: {
        status: "waiting",
        waits: [{ kind: "decision", name: "", expiresAt: 0 }],
        control: {
          canPause: true,
          canResume: false,
          canCancel: true,
          pendingControl: null,
        },
      },
      // Pausing keeps what it waits for.
      paused: {
        status: "paused",
        waits: [{ kind: "decision", name: "", expiresAt: 0 }],
        control: {
          canPause: false,
          canResume: true,
          canCancel: true,
          pendingControl: null,
        },
      },
      answered: {
        status: "paused",
        waits: [],
        control: {
          canPause: false,
          canResume: true,
          canCancel: true,
          pendingControl: null,
        },
      },
      done: { status: "completed", waits: [], control: none },
      newer: true,
      started: true,
      finished: true,
      identity: [
        { runId: run, workflowId: "approval", workflowVersion: 1 },
        { runId: run, workflowId: "approval", workflowVersion: 1 },
      ],
    });
  });

  it("offer no control to someone who doesn't build the App, and keep another App's run from them", async () => {
    const builder = await personApi("builder");
    const user = await personApi("user");
    const app = await approvalApp(builder);
    const other = await approvalApp(builder);
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const { id: run } = await builder.api.screens.startRun(
      app,
      "approval",
      byAdmins
    );
    const seen = await summaryWhen(
      user,
      app,
      run,
      ({ status }) => status === "waiting"
    );

    expect({
      control: seen.control,
      otherApp: await outcome(builder.api.screens.summary(other, run)),
    }).toStrictEqual({
      control: none,
      otherApp: "workflow.run_not_found",
    });
  });

  it("name a decision it waits for as the version's review does, without the key it is asked under", async () => {
    const builder = await personApi("builder");
    const user = await personApi("user");
    const invoice = `invoice-${crypto.randomUUID()}`;
    const app = await appWith(builder, {
      "workflows/keyed.ts": `import { person, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "keyed",
  {
    params: { reviewer: person({ label: "Reviewer", default: "role:admin" }) },
    input: z.object({ invoice: z.string() }),
  },
  async (step, { input, params }) =>
    await step.decision("review", {
      key: input.invoice,
      description: "Approve the invoice",
      from: params.reviewer,
      ask: async () => {},
      timeout: "7 days",
    })
);
`,
      "workflows/keyed.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./keyed.ts";

export default workflowTests(definition, [
  { name: "waits", input: { invoice: "i" }, decisions: { review: { approved: true, by: "anna" } }, expect: {} },
]);
`,
    });
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const { id: run } = await builder.api.screens.startRun(app, "keyed", {
      invoice,
    });

    const waiting = await summaryWhen(
      user,
      app,
      run,
      ({ waits }) => waits.length === 1
    );

    expect(waiting.waits.map(({ name }) => name)).toStrictEqual(["review"]);
    expect(JSON.stringify(waiting)).not.toContain(invoice);
  });

  it("show a pause still being applied, which leaves cancelling open, and a failed run's error", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, {
      ...workflowFiles(
        "gated",
        `  await step.do("first", { description: "First" }, async () => {
    while ((await env.APP.call("hits", "gate")) === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return null;
  });
  return await step.do("after", { description: "After" }, async () => null);`,
        { first: null, after: null }
      ),
      ...workflowFiles(
        "failing",
        `  return await step.do("fail", { description: "Fail", retries: { limit: 0 } }, async () => {
    throw Object.assign(new Error("No such invoice"), { code: "invoice.missing" });
  });`,
        { fail: null }
      ),
    });
    const { id: gated } = await builder.api.screens.startRun(app, "gated");
    await summaryWhen(
      builder,
      app,
      gated,
      ({ status }) => status === "running"
    );
    await builder.api.screens.control(app, gated, "pause");
    const pausing = await builder.api.screens.summary(app, gated);
    await builder.api.screens.control(app, gated, "cancel");
    const cancelled = await summaryWhen(
      builder,
      app,
      gated,
      ({ status }) => status === "cancelled"
    );
    const { id: failing } = await builder.api.screens.startRun(app, "failing");
    const failed = await summaryWhen(
      builder,
      app,
      failing,
      ({ status }) => status === "failed"
    );

    expect({
      pausing: pausing.control,
      cancelled: shape(cancelled),
      failed: shape(failed),
    }).toStrictEqual({
      pausing: {
        canPause: false,
        canResume: false,
        canCancel: true,
        pendingControl: { kind: "pause", stage: "applying" },
      },
      cancelled: { status: "cancelled", waits: [], control: none },
      failed: {
        status: "failed",
        waits: [],
        control: none,
        error: { code: "invoice.missing", message: "No such invoice" },
      },
    });
  });

  it("show a failed run's error to its person and admins only, its message gone once its details are removed", async () => {
    const builder = await personApi("builder");
    const user = await personApi("user");
    const admin = await personApi("admin");
    const app = await appWith(
      builder,
      workflowFiles(
        "failing",
        `  return await step.do("fail", { description: "Fail", retries: { limit: 0 } }, async () => {
    throw Object.assign(new Error("Invoice INV-7 of Acme is missing"), { code: "invoice.missing" });
  });`,
        { fail: null }
      )
    );
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const { id: run } = await builder.api.screens.startRun(app, "failing");
    const own = await summaryWhen(
      builder,
      app,
      run,
      ({ status }) => status === "failed"
    );
    const other = await user.api.screens.summary(app, run);
    const byAdmin = await admin.api.screens.summary(app, run);
    await env.DB.prepare(
      "UPDATE workflow_runs SET details_removed_at = ? WHERE id = ?"
    )
      .bind(Date.now(), run)
      .run();
    const removed = await builder.api.screens.summary(app, run);
    const { failure } = await builder.api.workflows.status(run);

    expect({
      own: own.error,
      other: other.error,
      byAdmin: byAdmin.error,
      removed: removed.error,
    }).toStrictEqual({
      own: {
        code: "invoice.missing",
        message: "Invoice INV-7 of Acme is missing",
      },
      other: undefined,
      byAdmin: {
        code: "invoice.missing",
        message: "Invoice INV-7 of Acme is missing",
      },
      // As the run's status says it.
      removed: { code: "invoice.missing", message: failure?.error.message },
    });
  });

  it("hide an expired failed run's message before its details are swept, and give the sweep a revision of its own", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "failing",
        `  return await step.do("fail", { description: "Fail", retries: { limit: 0 } }, async () => {
    throw Object.assign(new Error("Invoice INV-7 of Acme is missing"), { code: "invoice.missing" });
  });`,
        { fail: null }
      )
    );
    const { id: run } = await builder.api.screens.startRun(app, "failing");
    await summaryWhen(builder, app, run, ({ status }) => status === "failed");
    // Ended longer ago than the run retention (30 days): the sweep hasn't
    // been by yet.
    const longAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await env.DB.prepare("UPDATE workflow_runs SET ended_at = ? WHERE id = ?")
      .bind(longAgo, run)
      .run();
    const expired = await builder.api.screens.summary(app, run);
    await sweepRunDetails(env, new Date());
    const swept = await builder.api.screens.summary(app, run);

    expect({
      expired: expired.error,
      swept: swept.error,
      revised: swept.revision > expired.revision,
    }).toStrictEqual({
      expired: { code: "invoice.missing", message: removedText(env) },
      swept: { code: "invoice.missing", message: removedText(env) },
      revised: true,
    });
  });

  it("keep when a run first ran, though the engine's batch skips past running to its end", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles("quick", "  return null;", {})
    );
    const { id: run } = await builder.api.screens.startRun(app, "quick");
    const done = await summaryWhen(
      builder,
      app,
      run,
      ({ status }) => status === "completed"
    );
    // A row whose engine's first notification it takes is its end, with
    // when the run first ran, as a batch that went from running to waiting
    // to complete hands it over; then a later one, which can't move it.
    const skipped = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at) VALUES (?, ?, 'quick', 1, ?, 'starting', ?)"
    )
      .bind(skipped, app, builder.userId, Date.now() - 5000)
      .run();
    const firstRan = Date.now() - 4000;
    await projectStatus(env, skipped, {
      status: "complete",
      at: Date.now(),
      sequence: 4,
      startedAt: firstRan,
    });
    await projectStatus(env, skipped, {
      status: "complete",
      at: Date.now(),
      sequence: 5,
      startedAt: Date.now(),
    });
    const projected = await builder.api.screens.summary(app, skipped);

    expect({
      ran: done.startedAt !== null && done.startedAt <= (done.finishedAt ?? 0),
      skipped: projected.startedAt,
    }).toStrictEqual({ ran: true, skipped: firstRan });
  });
});
