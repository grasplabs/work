import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  approvePlan,
  buildOf,
  confirmCredentials,
  recordMerge,
  recordPlan,
  recordPullRequest,
  requestBuild,
  sendBackPlan,
} from "../src/builds/builds.ts";
import type { BuildPlan } from "../src/builds/plan.ts";
import { consoleDatabase } from "../src/db/act.ts";
import { auditEvents, integrationBuilds } from "../src/db/schema.ts";

// How a build can go wrong, and what each test holds it to:
// - Two people press Build it for one app: one build, one run.
// - An event arrives twice, late, or for an older plan: the build moves
//   once and never back, and approving a plan never approves a newer one.
// - The agent's plan names hosts its actions don't keep to, or another
//   app: refused, and the build stays where it is.
// - The agent opens its pull request from another branch, or a merge of
//   another pull request is reported: refused.
// - Nobody acts: the wait runs out and the build stops for a person.
// - The audit log records identifiers and counts, never the plan's or a
//   person's words.

const db = consoleDatabase(env.DB);
const staff = { email: "staff@grasp.test", sub: "sub-staff" };
const mergeSha = "0123456789abcdef0123456789abcdef01234567";

/** A new app's connector name, unique to the test. */
const newApp = () => `app-${crypto.randomUUID().slice(0, 8)}`;

/** A plan for `app`, signed in to as `signIn`. */
const planFor = (
  app: string,
  signIn: BuildPlan["signIn"] = "oauth2"
): BuildPlan => ({
  app,
  signIn,
  hosts: ["api.example-hr.test"],
  actions: [
    {
      action: "employees.read",
      description: "Reads the company's employees.",
      changes: false,
      hosts: ["api.example-hr.test"],
    },
  ],
  docs: ["https://developer.example-hr.test/docs"],
});

/** The code an action was refused with, or `resolved`. */
const codeOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error && "code" in error
      ? error.code
      : "not a build error";
  }
  return "resolved";
};

/** An audit event's detail: identifiers and counts. */
const detailSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .nullable();

/** The audit trail of the build of `app`: actor, action and detail, in order. */
const trailOf = async (app: string) => {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.target, app))
    .orderBy(asc(auditEvents.at));
  return rows.map(({ actor, action, detail }) => ({
    actor,
    action,
    detail: detailSchema.parse(JSON.parse(detail ?? "null")),
  }));
};

/** The builds' runs the test starts, retries going at once. */
const followBuilds = async () => {
  const runs = await introspectWorkflow(env.INTEGRATION_BUILD);
  await runs.modifyAll(async (modifier) => {
    await modifier.disableRetryDelays();
  });
  return runs;
};

/** The only run of `runs`. */
const onlyRun = async (runs: Awaited<ReturnType<typeof followBuilds>>) => {
  const all = await runs.get();
  const [run] = all;
  if (run === undefined || all.length !== 1) {
    throw new Error(`Expected one build's run, got ${all.length}`);
  }
  return run;
};

describe("integration builds", () => {
  it("follows a build from Build it to its merge, a sent-back plan included", async () => {
    await using runs = await followBuilds();
    const app = newApp();

    await requestBuild(env, staff, { app, name: "Example HR" });
    const run = await onlyRun(runs);
    await run.waitForStepResult({ name: "plan 1 check" });
    await recordPlan(env, app, {
      ...planFor(app),
      hosts: ["api.example-hr.test", "files.example-hr.test"],
    });
    await run.waitForStepResult({ name: "decision 1 check" });
    await sendBackPlan(
      env,
      staff,
      app,
      1,
      "Only what reads employees, please."
    );
    await run.waitForStepResult({ name: "plan 2 check" });
    const sentBack = await buildOf(db, app);
    await recordPlan(env, app, planFor(app));
    await approvePlan(env, staff, app, 2);
    await confirmCredentials(env, staff, app);
    await recordPullRequest(env, app, {
      number: 4242,
      branch: `feat/connector-${app}`,
    });
    await recordMerge(env, app, { number: 4242, commitSha: mergeSha });
    await run.waitForStatus("complete");

    const build = await buildOf(db, app);
    expect({
      sentBack: { stage: sentBack?.stage, note: sentBack?.planNote },
      output: await run.getOutput(),
      build: {
        stage: build?.stage,
        planRound: build?.planRound,
        hosts: build?.plan?.hosts,
        approvedBy: build?.approvedBy,
        branch: build?.branch,
        pullRequest: build?.pullRequest,
        mergeCommitSha: build?.mergeCommitSha,
      },
      trail: await trailOf(app),
    }).toStrictEqual({
      sentBack: {
        stage: "researching",
        note: "Only what reads employees, please.",
      },
      output: "merged",
      build: {
        stage: "merged",
        planRound: 2,
        hosts: ["api.example-hr.test"],
        approvedBy: staff.email,
        branch: `feat/connector-${app}`,
        pullRequest: 4242,
        mergeCommitSha: mergeSha,
      },
      trail: [
        {
          actor: staff.email,
          action: "build.request",
          detail: { run: build?.runId },
        },
        {
          actor: "system",
          action: "build.research",
          detail: { stage: "researching" },
        },
        {
          actor: "system",
          action: "build.plan",
          detail: { stage: "plan_ready", round: 1, actions: 1, hosts: 2 },
        },
        {
          actor: staff.email,
          action: "build.send_back",
          detail: { stage: "researching", round: 1 },
        },
        {
          actor: "system",
          action: "build.plan",
          detail: { stage: "plan_ready", round: 2, actions: 1, hosts: 1 },
        },
        {
          actor: staff.email,
          action: "build.approve",
          detail: { stage: "credentials", round: 2 },
        },
        {
          actor: staff.email,
          action: "build.credentials",
          detail: { stage: "writing" },
        },
        {
          actor: "system",
          action: "build.pull_request",
          detail: { stage: "in_review", pull_request: 4242 },
        },
        {
          actor: "system",
          action: "build.merge",
          detail: { stage: "merged", pull_request: 4242, commit: mergeSha },
        },
      ],
    });
  });

  it("starts one build however many times Build it is pressed for an app", async () => {
    await using runs = await followBuilds();
    const app = newApp();

    const first = await requestBuild(env, staff, { app, name: "Example HR" });
    const again = await requestBuild(
      env,
      { email: "other@grasp.test", sub: "sub-other" },
      { app, name: "Example HR" }
    );

    const all = await runs.get();
    const trail = await trailOf(app);
    expect({
      again,
      runs: all.length,
      requests: trail.filter(({ action }) => action === "build.request").length,
    }).toStrictEqual({ again: first, runs: 1, requests: 1 });
  });

  it("refuses an app no connector can be named for", async () => {
    const refused = {
      pathInBranch: await codeOf(
        requestBuild(env, staff, { app: "x/../../main", name: "Example HR" })
      ),
      upperCase: await codeOf(
        requestBuild(env, staff, { app: "ExampleHR", name: "Example HR" })
      ),
      noName: await codeOf(
        requestBuild(env, staff, { app: newApp(), name: "  " })
      ),
    };

    expect(refused).toStrictEqual({
      pathInBranch: "invalid_app",
      upperCase: "invalid_app",
      noName: "invalid_app",
    });
  });

  it("starts a build's run on the next Build it when the first never started", async () => {
    await using runs = await followBuilds();
    const app = newApp();
    const failing = vi
      .spyOn(env.INTEGRATION_BUILD, "create")
      .mockRejectedValueOnce(new Error("Workflows is unavailable"));
    const first = await codeOf(
      requestBuild(env, staff, { app, name: "Example HR" })
    );
    failing.mockRestore();
    // Long enough ago that a run Workflows doesn't have isn't starting.
    await db
      .update(integrationBuilds)
      .set({ createdAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(integrationBuilds.app, app));

    const runId = await requestBuild(env, staff, { app, name: "Example HR" });
    const run = await onlyRun(runs);
    await run.waitForStepResult({ name: "plan 1 check" });

    const build = await buildOf(db, app);
    expect({ first, runId, stage: build?.stage }).toStrictEqual({
      first: "not a build error",
      runId: build?.runId,
      stage: "researching",
    });
  });

  it("goes straight to writing once a plan for an app's own API keys is approved", async () => {
    await using runs = await followBuilds();
    const app = newApp();
    await requestBuild(env, staff, { app, name: "Example HR" });
    const run = await onlyRun(runs);
    await run.waitForStepResult({ name: "plan 1 check" });

    await recordPlan(env, app, planFor(app, "api_key"));
    const next = await approvePlan(env, staff, app, 1);
    const credentials = await codeOf(confirmCredentials(env, staff, app));
    await run.waitForStepResult({ name: "pull request check" });

    const build = await buildOf(db, app);
    expect({
      next,
      credentials,
      stage: build?.stage,
    }).toStrictEqual({
      next: "writing",
      credentials: "wrong_stage",
      stage: "writing",
    });
  });

  it("moves a build once and never back when an event comes twice, late or for an older plan", async () => {
    await using runs = await followBuilds();
    const app = newApp();
    await requestBuild(env, staff, { app, name: "Example HR" });
    const run = await onlyRun(runs);
    await run.waitForStepResult({ name: "plan 1 check" });
    await recordPlan(env, app, planFor(app));
    await sendBackPlan(env, staff, app, 1, "Fewer actions.");
    await recordPlan(env, app, planFor(app));

    const refused = {
      // The plan the person read was round 1; round 2 is newer.
      staleApproval: await codeOf(approvePlan(env, staff, app, 1)),
      staleSendBack: await codeOf(sendBackPlan(env, staff, app, 1, "Again.")),
      emptyNote: await codeOf(sendBackPlan(env, staff, app, 2, "   ")),
      // The agent reports a plan while one waits for a person.
      planAgain: await codeOf(recordPlan(env, app, planFor(app))),
      earlyPullRequest: await codeOf(
        recordPullRequest(env, app, {
          number: 7,
          branch: `feat/connector-${app}`,
        })
      ),
    };
    await approvePlan(env, staff, app, 2);
    const approveAgain = await codeOf(approvePlan(env, staff, app, 2));

    const build = await buildOf(db, app);
    const trail = await trailOf(app);
    expect({
      refused,
      approveAgain,
      stage: build?.stage,
      approvals: trail.filter(({ action }) => action === "build.approve")
        .length,
    }).toStrictEqual({
      refused: {
        staleApproval: "wrong_stage",
        staleSendBack: "wrong_stage",
        emptyNote: "note_required",
        planAgain: "wrong_stage",
        earlyPullRequest: "wrong_stage",
      },
      approveAgain: "wrong_stage",
      stage: "credentials",
      approvals: 1,
    });
  });

  it("refuses a plan that reaches past its own hosts or is for another app", async () => {
    await using runs = await followBuilds();
    const app = newApp();
    await requestBuild(env, staff, { app, name: "Example HR" });
    const run = await onlyRun(runs);
    await run.waitForStepResult({ name: "plan 1 check" });
    const plan = planFor(app);
    const [action] = plan.actions;
    if (action === undefined) {
      throw new Error("The plan has no action");
    }

    const refused = {
      undeclaredHost: await codeOf(
        recordPlan(env, app, {
          ...plan,
          actions: [{ ...action, hosts: ["exfiltrate.example.test"] }],
        })
      ),
      ipAddress: await codeOf(
        recordPlan(env, app, {
          ...plan,
          hosts: ["10.0.0.1"],
          actions: [{ ...action, hosts: ["10.0.0.1"] }],
        })
      ),
      otherApp: await codeOf(recordPlan(env, app, planFor(newApp()))),
      extraField: await codeOf(recordPlan(env, app, { ...plan, secret: "x" })),
    };

    const build = await buildOf(db, app);
    expect({ refused, stage: build?.stage, plan: build?.plan }).toStrictEqual({
      refused: {
        undeclaredHost: "invalid_plan",
        ipAddress: "invalid_plan",
        otherApp: "invalid_plan",
        extraField: "invalid_plan",
      },
      stage: "researching",
      plan: null,
    });
  });

  it("takes a pull request only from the build's own branch, and a merge only of it", async () => {
    await using runs = await followBuilds();
    const app = newApp();
    await requestBuild(env, staff, { app, name: "Example HR" });
    const run = await onlyRun(runs);
    await run.waitForStepResult({ name: "plan 1 check" });
    await recordPlan(env, app, planFor(app, "api_key"));
    await approvePlan(env, staff, app, 1);

    const otherBranch = await codeOf(
      recordPullRequest(env, app, { number: 9, branch: "main" })
    );
    await recordPullRequest(env, app, {
      number: 9,
      branch: `feat/connector-${app}`,
    });
    const otherPullRequest = await codeOf(
      recordMerge(env, app, { number: 10, commitSha: mergeSha })
    );

    const build = await buildOf(db, app);
    expect({
      otherBranch,
      otherPullRequest,
      stage: build?.stage,
    }).toStrictEqual({
      otherBranch: "wrong_branch",
      otherPullRequest: "wrong_pull_request",
      stage: "in_review",
    });
  });

  it("stops a build for a person when the agent never writes its plan", async () => {
    await using runs = await followBuilds();
    await runs.modifyAll(async (modifier) => {
      await modifier.forceEventTimeout({ name: "plan 1" });
    });
    const app = newApp();
    await requestBuild(env, staff, { app, name: "Example HR" });
    const run = await onlyRun(runs);
    await run.waitForStatus("complete");
    const late = await codeOf(recordPlan(env, app, planFor(app)));

    const build = await buildOf(db, app);
    expect({
      output: await run.getOutput(),
      late,
      build: {
        stage: build?.stage,
        stoppedAt: build?.stoppedAt,
        reason: build?.reason,
      },
    }).toStrictEqual({
      output: "researching_timed_out",
      late: "wrong_stage",
      build: {
        stage: "needs_person",
        stoppedAt: "researching",
        reason: "researching_timed_out",
      },
    });
  });
});
