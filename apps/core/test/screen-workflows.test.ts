import { expectedMessageOf } from "@grasp-os/shared/errors";
import type { ScreenRun } from "@grasp-os/shared/screens";
import type { RunStatus, WorkflowRun } from "@grasp-os/shared/workflows";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { toScreenRun } from "../src/workflows/screen-runs.ts";
import { allEvents } from "./audit-events.ts";
import { approvalApp, confirmedDecide, week } from "./decisions.ts";
import type { Person } from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import { gate, rollingBackRun, withRollbacks } from "./rollbacks.ts";
import { endLiveRuns, finished, runInstance, sleeping, woken } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// An App's screens and its workflows, together: a screen starts a run of
// its App's workflow, follows it, and answers its decisions, for the
// person using it. The ways this could go wrong, tried below: a screen
// reaching another App's runs or decisions (whatever the person may do
// there), someone without a role in the App starting or reading runs, a
// decision answered through a screen by someone its rules leave out (not
// who it is from, or the run's starter), what workflow code wrote in a
// decision's description reaching someone who may neither answer it nor
// see the run's details, a start or answer on a screen that the audit log
// can't tell from a direct one, and the feature not switching off.

const idp = mockIdp();

const personApi = async (role: "admin" | "builder" | "user") =>
  await signedInApi(idp, role);

/**
 * `value` as whatever a call takes: what a page made to pass on anything
 * can send, which core must refuse.
 */
const unchecked = (value: unknown): never =>
  // SAFETY: invalid on purpose; Cap'n Web checks no types, so core must.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  value as never;

/** The approval workflow's input: a decision any admin answers, for a week. */
const byAdmins = { from: "role:admin", timeout: week };

/** The run, as `person` sees it on a screen of `app`, once it waits. */
const waiting = async (
  person: Person,
  app: string,
  run: string
): Promise<ScreenRun> =>
  await vi.waitFor(
    async () => {
      const found = await person.api.screens.frame(app, "").run(run);
      if (found.status !== "waiting") {
        throw new Error(`The run is ${found.status}`);
      }
      return found;
    },
    { timeout: 20_000, interval: 100 }
  );

describe("workflows from screens", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("start a run, show it waiting for its decision, and take the answer of someone it is from", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const app = await approvalApp(builder);

    const { id: run } = await builder.api.screens
      .frame(app, "")
      .startRun("approval", byAdmins);
    await waiting(builder, app, run);
    const whileWaiting = {
      run: await builder.api.screens.frame(app, "").run(run),
      runs: await admin.api.screens.frame(app, "").runs("approval"),
      // The run's starter doesn't answer a decision of all admins (#87).
      starter: await outcome(
        builder.api.screens
          .frame(app, "")
          .decide(run, "review", { approved: true })
      ),
    };
    const answered = await confirmedDecide(admin, app, run, "review", {
      approved: true,
      payload: { comment: "Matches the PO" },
    });
    await finished(run);
    const events = await allEvents();
    const started = events.find(
      ({ action, target }) =>
        action === "workflow.run.started" && target?.id === run
    );
    const approved = events.find(
      ({ action, detail }) =>
        action === "workflow.decision.approved" && detail.run === run
    );

    expect({
      started: { actor: started?.actor, via: started?.detail.via },
      approved: { actor: approved?.actor, via: approved?.detail.via },
      whileWaiting,
      answered: answered.status,
      after: await builder.api.screens.frame(app, "").run(run),
      runs: await builder.api.screens.frame(app, "").runs("approval"),
    }).toMatchObject({
      // Audited under who they were for, and that a screen did it.
      started: {
        actor: { type: "person", userId: builder.userId },
        via: "screen",
      },
      approved: {
        actor: { type: "person", userId: admin.userId },
        via: "screen",
      },
      whileWaiting: {
        run: {
          id: run,
          status: "waiting",
          waitingFor: [{ name: "review", description: "Approve the invoice" }],
        },
        runs: [
          { id: run, status: "waiting", waitingFor: [{ name: "review" }] },
        ],
        starter: "decision.forbidden",
      },
      answered: "approved",
      after: {
        status: "completed",
        waitingFor: [],
        output: {
          approved: true,
          by: admin.userId,
          payload: { comment: "Matches the PO" },
        },
      },
      runs: [{ id: run, status: "completed", waitingFor: [] }],
    });
  });

  it("let someone the App is shared with as a user start runs, and only those its decisions are from answer", async () => {
    const builder = await personApi("builder");
    const user = await personApi("user");
    const other = await personApi("user");
    const app = await approvalApp(builder);
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    await builder.api.apps.members.add(app, {
      type: "person",
      id: other.userId,
      role: "user",
    });

    const run = await user.api.screens.frame(app, "").startRun("approval", {
      from: `person:${builder.userId}`,
      timeout: week,
    });
    await waiting(user, app, run.id);
    // A second run, whose decision asks `other`: listing both takes the
    // answers of more than one set of deciders at once.
    const second = await builder.api.screens
      .frame(app, "")
      .startRun("approval", {
        from: `person:${other.userId}`,
        timeout: week,
      });
    await waiting(builder, app, second.id);
    /** Each run's description, as `person` sees it listed and on its own. */
    const descriptions = async (person: Person) => {
      const listed = await person.api.screens.frame(app, "").runs("approval");
      return await Promise.all(
        [run.id, second.id].map(async (id) => {
          const found = await person.api.screens.frame(app, "").run(id);
          const inList = listed.find((each) => each.id === id);
          return [inList?.waitingFor, found.waitingFor].map((decisions) =>
            decisions?.map(({ description }) => description ?? "(hidden)")
          );
        })
      );
    };
    // A run's starter sees its details, the person its decision asks may
    // answer it; anyone else sees only that it waits, and until when.
    const seen = {
      starter: await descriptions(user),
      named: await descriptions(builder),
      other: await descriptions(other),
    };
    const shown = [["Approve the invoice"], ["Approve the invoice"]];
    const hidden = [["(hidden)"], ["(hidden)"]];

    expect({
      seen,
      other: await outcome(
        other.api.screens
          .frame(app, "")
          .decide(run.id, "review", { approved: true })
      ),
      starter: await outcome(
        user.api.screens
          .frame(app, "")
          .decide(run.id, "review", { approved: true })
      ),
      named: await outcome(
        confirmedDecide(builder, app, run.id, "review", { approved: false })
      ),
      again: await outcome(
        builder.api.screens
          .frame(app, "")
          .decide(run.id, "review", { approved: true })
      ),
    }).toStrictEqual({
      seen: {
        // Started the first; neither started nor asked by the second.
        starter: [shown, hidden],
        // Asked by the first; started the second.
        named: [shown, shown],
        // Asked by the second only.
        other: [hidden, shown],
      },
      other: "decision.forbidden",
      starter: "decision.forbidden",
      named: "ok",
      again: "decision.closed",
    });
  });

  it("answer only with the confirmation the page minted, never one the screen holds, makes up or sends inside its answer", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const otherAdmin = await personApi("admin");
    const app = await approvalApp(builder);
    const run = await builder.api.screens
      .frame(app, "")
      .startRun("approval", byAdmins);
    const second = await builder.api.screens
      .frame(app, "")
      .startRun("approval", byAdmins);
    await waiting(admin, app, run.id);
    await waiting(admin, app, second.id);
    const reviewOf = async (person: Person, of: string, approved: boolean) => {
      const review = await person.api.screens
        .frame(app, "")
        .reviewDecision(of, "review", { approved });
      if (review.state !== "review") {
        throw new Error("Already recorded");
      }
      return review;
    };
    const confirmed = async (person: Person, of: string, approved: boolean) => {
      const { decision } = await reviewOf(person, of, approved);
      const { confirmation } = await person.api.screens
        .frame(app, "")
        .confirmDecision(of, "review", decision.revision, { approved });
      return confirmation;
    };
    const rejecting = await confirmed(admin, run.id, false);
    const forSecond = await confirmed(admin, second.id, true);
    const otherAdmins = await confirmed(otherAdmin, run.id, true);
    const decide = async (answer: unknown, confirmation?: string) =>
      await outcome(
        admin.api.screens
          .frame(app, "")
          .decide(run.id, "review", unchecked(answer), confirmation)
      );

    const refused = {
      // What a screen can send on its own: no confirmation, one it made
      // up, or one tucked into its answer.
      none: await decide({ approved: true }),
      madeUp: await decide({ approved: true }, "c2NyZWVuLW1hZGUtdGhpcw"),
      inTheAnswer: await decide({ approved: true, confirmation: rejecting }),
      // Confirmed by the person, but for another answer, another decision
      // or by someone else.
      otherAnswer: await decide({ approved: true }, rejecting),
      otherDecision: await decide({ approved: true }, forSecond),
      otherPerson: await decide({ approved: true }, otherAdmins),
      // Nor confirmed against a review the decision no longer matches.
      staleReview: await outcome(
        admin.api.screens
          .frame(app, "")
          .confirmDecision(run.id, "review", "stale", {
            approved: true,
          })
      ),
      // Nor reviewed through another App.
      elsewhere: await outcome(
        admin.api.screens
          .frame(await approvalApp(builder), "")
          .reviewDecision(run.id, "review", { approved: true })
      ),
    };
    const { status: stillWaiting } = await admin.api.screens
      .frame(app, "")
      .run(run.id);
    const answered = await decide({ approved: false }, rejecting);
    // Asked again after it was recorded, as after a lost answer: nothing
    // more to confirm, and the same answer is given back.
    const recorded = await admin.api.screens
      .frame(app, "")
      .reviewDecision(run.id, "review", { approved: false });
    const again = await decide({ approved: false });
    await finished(run.id);
    const events = await allEvents();
    const refusals = events
      .filter(
        ({ action, detail }) =>
          action === "workflow.decision.answer_refused" && detail.run === run.id
      )
      .map(
        ({ detail }) =>
          `${detail.errorCode} ${detail.via}${detail.stage === undefined ? "" : ` ${detail.stage}`}`
      );
    const confirmations = events
      .filter(
        ({ action, detail }) =>
          action === "workflow.decision.confirmed" && detail.run === run.id
      )
      .map(({ actor, detail }) => ({
        actor,
        via: detail.via,
        keys: Object.keys(detail).toSorted(),
      }));

    expect({
      refused,
      stillWaiting,
      answered,
      recorded: recorded.state,
      again,
      refusals: refusals.toSorted(),
      confirmations,
    }).toStrictEqual({
      refused: {
        none: "decision.unconfirmed",
        madeUp: "decision.unconfirmed",
        inTheAnswer: "decision.invalid",
        otherAnswer: "decision.unconfirmed",
        otherDecision: "decision.unconfirmed",
        otherPerson: "decision.unconfirmed",
        staleReview: "decision.conflict",
        elsewhere: "decision.not_found",
      },
      stillWaiting: "waiting",
      answered: "ok",
      recorded: "recorded",
      again: "ok",
      // Each refused answer or confirmation audited as tried on a screen;
      // the invalid one never got that far.
      refusals: [
        ...Array.from({ length: 5 }, () => "decision.unconfirmed screen"),
        "decision.conflict screen confirm",
      ].toSorted(),
      // Each confirmation audited as given for a screen: who, until when,
      // never the token nor the answer.
      confirmations: [admin, otherAdmin].map(({ userId }) => ({
        actor: { type: "person", userId },
        via: "screen",
        keys: ["app", "expiresAt", "run", "step", "version", "via", "workflow"],
      })),
    });
  });

  it("never reach another App's runs or decisions, whatever the person may do there", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const [app, elsewhere] = await Promise.all([
      approvalApp(builder),
      approvalApp(builder),
    ]);
    const run = await builder.api.screens
      .frame(elsewhere, "")
      .startRun("approval", byAdmins);
    await waiting(admin, elsewhere, run.id);

    expect({
      run: await outcome(admin.api.screens.frame(app, "").run(run.id)),
      decide: await outcome(
        admin.api.screens
          .frame(app, "")
          .decide(run.id, "review", { approved: true })
      ),
      runs: await admin.api.screens.frame(app, "").runs("approval"),
      // Nor a decision the run doesn't have, or a name that isn't one.
      unknown: await outcome(
        admin.api.screens.frame(elsewhere, "").decide(run.id, "other", {
          approved: true,
        })
      ),
      invalid: await outcome(
        admin.api.screens.frame(elsewhere, "").decide(run.id, unchecked(7), {
          approved: true,
        })
      ),
      invalidRun: await outcome(
        admin.api.screens.frame(elsewhere, "").run(unchecked({ id: run.id }))
      ),
      // Still waiting: nothing above answered it.
      stillWaiting: await admin.api.screens
        .frame(elsewhere, "")
        .run(run.id)
        .then(({ status }) => status),
    }).toStrictEqual({
      run: "workflow.run_not_found",
      decide: "decision.not_found",
      runs: [],
      unknown: "decision.not_found",
      invalid: "decision.invalid",
      invalidRun: "workflow.invalid",
      stillWaiting: "waiting",
    });
  });

  it("show a run that sleeps as running, in the list and on its own, and list only the workflow asked for", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, {
      ...workflowFiles(
        "napping",
        `  await step.sleep("nap", { description: "Wait a day", duration: "1 day" });
  return 1;`
      ),
      ...workflowFiles(
        "resting",
        `  await step.sleep("rest", { description: "Wait a day", duration: "1 day" });
  return 1;`
      ),
    });
    const napping = await builder.api.screens
      .frame(app, "")
      .startRun("napping");
    const resting = await builder.api.screens
      .frame(app, "")
      .startRun("resting");
    await sleeping(napping.id, "nap");
    await sleeping(resting.id, "rest");
    const seen = async (workflow: string, run: string) => ({
      listed: await builder.api.screens
        .frame(app, "")
        .runs(workflow)
        .then((runs) =>
          runs.map(({ id, status, waitingFor }) => ({ id, status, waitingFor }))
        ),
      run: await builder.api.screens
        .frame(app, "")
        .run(run)
        .then(({ status, waitingFor }) => ({ status, waitingFor })),
    });

    expect({
      napping: await seen("napping", napping.id),
      resting: await seen("resting", resting.id),
    }).toStrictEqual({
      napping: {
        listed: [{ id: napping.id, status: "running", waitingFor: [] }],
        run: { status: "running", waitingFor: [] },
      },
      resting: {
        listed: [{ id: resting.id, status: "running", waitingFor: [] }],
        run: { status: "running", waitingFor: [] },
      },
    });
  });

  it("refuse someone without a role in the App, as if it weren't there", async () => {
    const builder = await personApi("builder");
    const stranger = await personApi("builder");
    const app = await approvalApp(builder);
    const run = await builder.api.screens
      .frame(app, "")
      .startRun("approval", byAdmins);
    await waiting(builder, app, run.id);

    expect({
      start: await outcome(
        stranger.api.screens.frame(app, "").startRun("approval", byAdmins)
      ),
      runs: await outcome(stranger.api.screens.frame(app, "").runs("approval")),
      run: await outcome(stranger.api.screens.frame(app, "").run(run.id)),
      decide: await outcome(
        stranger.api.screens
          .frame(app, "")
          .decide(run.id, "review", { approved: true })
      ),
    }).toStrictEqual({
      start: "app.not_found",
      runs: "app.not_found",
      run: "app.not_found",
      decide: "app.not_found",
    });
  });
});

// Where a screen shows a run, from where core has it and the decisions it
// waits for: pure logic, and the one place both `run` and `runs` go
// through. The local engine never reports `waiting`, which Cloudflare
// Workflows does for a run that sleeps.
describe(toScreenRun, () => {
  const run = (status: RunStatus): WorkflowRun => ({
    id: unchecked("run"),
    app: unchecked("app"),
    workflow: unchecked("approval"),
    version: 1,
    startedBy: { type: "trigger" },
    status,
    createdAt: "2026-09-27T00:00:00.000Z",
    endedAt: null,
  });
  const review = { name: "review", expiresAt: "2026-10-04T00:00:00.000Z" };
  const shown = (status: RunStatus, decisions: (typeof review)[]) => {
    const { status: showing, waitingFor } = toScreenRun(run(status), decisions);
    return `${showing} ${waitingFor.length}`;
  };

  it("shows waiting exactly while a decision is open, and an ended run waiting for nothing", () => {
    expect({
      running: shown("running", []),
      engineWaiting: shown("waiting", []),
      runningWithDecision: shown("running", [review]),
      engineWaitingWithDecision: shown("waiting", [review]),
      paused: shown("paused", [review]),
      completed: shown("completed", [review]),
      failed: shown("failed", [review]),
      cancelled: shown("cancelled", [review]),
    }).toStrictEqual({
      running: "running 0",
      engineWaiting: "running 0",
      runningWithDecision: "waiting 1",
      engineWaitingWithDecision: "waiting 1",
      paused: "paused 1",
      completed: "completed 0",
      failed: "failed 0",
      cancelled: "cancelled 0",
    });
  });
});

// An App run whose engine rolls its steps back (spec 10.7.3), on the real
// engine with a test's definition (rollbacks.ts): no definition Grasp
// builds registers a rollback yet (GRA-984).
describe("an App run while it compensates", { timeout: 120_000 }, () => {
  withRollbacks();
  afterEach(endLiveRuns);

  /**
   * A run of an App's napping workflow, its next activation the test's
   * (`compensated`): its summary while the engine rolls it back, and once
   * it ended.
   */
  const compensatedRun = async (
    compensated: Omit<Parameters<typeof rollingBackRun>[1], "holds" | "held">,
    end?: (runId: string) => Promise<void>
  ) => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "napping",
        `  await step.sleep("nap", { description: "Wait a day", duration: "1 day" });
  return 1;`
      )
    );
    const frame = builder.api.screens.frame(app, "");
    const run = await frame.startRun("napping");
    await sleeping(run.id, "nap");
    const holds = gate();
    rollingBackRun(run.id, {
      ...compensated,
      holds,
      held: { name: "nap", ms: 86_400_000 },
    });
    await woken(run.id, "nap");
    await end?.(run.id);
    const compensating = await vi.waitFor(
      async () => {
        const summary = await frame.summary(run.id);
        expect(summary.status).toBe("compensating");
        return summary;
      },
      { timeout: 20_000, interval: 100 }
    );
    holds.open();
    await finished(run.id);
    const ended = await vi.waitFor(
      async () => {
        const summary = await frame.summary(run.id);
        expect(summary.finishedAt).not.toBeNull();
        return summary;
      },
      { timeout: 20_000, interval: 100 }
    );
    const { items } = await builder.api.workflows.history(run.id, {
      pageSize: 100,
    });
    return {
      // Its history's failures: its step's, and its compensation's.
      failures: items.flatMap((item) =>
        "error" in item ? [`${item.kind} ${item.error.code}`] : []
      ),
      compensating: {
        status: compensating.status,
        compensation: compensating.compensation,
        finishedAt: compensating.finishedAt,
        control: compensating.control,
      },
      ended: { status: ended.status, error: ended.error?.code },
    };
  };

  it("summarizes a failed run as compensating for its failure, with what it failed with, and failed once it's done", async () => {
    await expect(
      compensatedRun({ ends: { fails: "resource.declined" } })
    ).resolves.toStrictEqual({
      failures: ["step resource.declined"],
      compensating: {
        status: "compensating",
        compensation: {
          cause: "failure",
          activity: "running",
          originalError: {
            code: "resource.declined",
            message: expectedMessageOf("resource.declined"),
          },
        },
        finishedAt: null,
        // Nothing cuts a compensation short from an App.
        control: {
          canPause: false,
          canResume: false,
          canCancel: false,
          pendingControl: null,
        },
      },
      // The test's definition skips the run's own failure report, which
      // core's run code keeps as a run fails: its stop is said instead.
      ended: { status: "failed", error: "workflow.run_failed" },
    });
  });

  it("ends a run whose compensation failed as workflow.compensation_failed, and a cancellation's as cancelled", async () => {
    const failed = await compensatedRun({
      ends: { fails: "resource.declined" },
      rollbackFails: true,
    });
    const cancelled = await compensatedRun(
      { ends: "sleeps" },
      async (runId) => {
        await sleeping(runId, "after-charge");
        await runInstance(runId).terminate({ rollback: true });
      }
    );
    expect({
      failed: { ended: failed.ended, failures: failed.failures },
      cancelled: {
        compensation: cancelled.compensating.compensation,
        ended: cancelled.ended,
      },
    }).toStrictEqual({
      // Both errors kept in its history: its step's and its compensation's.
      failed: {
        ended: { status: "failed", error: "workflow.compensation_failed" },
        failures: ["step resource.declined", "compensation connect.declined"],
      },
      cancelled: {
        compensation: { cause: "cancellation", activity: "running" },
        ended: { status: "cancelled", error: undefined },
      },
    });
  });
});
