import type { RunSummary } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { approvalApp, week } from "./decisions.ts";
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
    await admin.api.decisions.answer(decision, { approved: true });
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
      waiting: {
        status: "waiting",
        waits: [{ kind: "decision", name: "review", expiresAt: 0 }],
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
        waits: [{ kind: "decision", name: "review", expiresAt: 0 }],
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
});
