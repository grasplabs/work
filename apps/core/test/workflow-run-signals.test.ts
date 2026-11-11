import type { ImprovementSignal } from "@grasp-os/shared/signals";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { refreshDailySignals } from "../src/daily-signals.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";
import {
  answer,
  chooseModel,
  endOf,
  ended,
  greetStep,
  greetingWorkflow,
  person,
  providerAnswering,
  started,
} from "./workflow-calls.ts";

// The improvement signals of independent workflows' runs (signals.ts):
// which task their failed runs failed at, and what their runs cost in
// model calls, by lineage. Read as the dashboard reads them, through the
// `signals` API as an admin.

const idp = mockIdp();

const dayMs = 24 * 60 * 60 * 1000;

/** Money rounded to millionths of a dollar, as the signals count it. */
const rounded = (amount: number): number => Math.round(amount * 1e6) / 1e6;

/**
 * The day the signals are computed as of, `ahead` days from now, at noon
 * UTC: some weeks on, so the runs made now are in its window and no other
 * test file's day is the same one. Each test its own: a day is computed
 * once.
 */
const computedOn = (ahead: number): Date => {
  const day = new Date();
  day.setUTCHours(12, 0, 0, 0);
  return new Date(day.getTime() + ahead * dayMs);
};

/** An expression that fails as it is evaluated: `who` has no 10,000th letter. */
const failing = 'args.who.split("")[9999].toUpperCase()';

/** Workflow `name`'s signals of `kind`, as an admin reads them. */
const signalsOf = <Kind extends ImprovementSignal["kind"]>(
  signals: readonly ImprovementSignal[],
  kind: Kind,
  name: string
) =>
  signals.filter(
    (signal): signal is Extract<ImprovementSignal, { kind: Kind }> =>
      signal.kind === kind && signal.workflow === name
  );

describe("an independent workflow's run signals", () => {
  beforeAll(chooseModel);

  it("count its failed runs by the task they failed at, with their codes, and its runs' model cost by lineage", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await greetingWorkflow(ada, admin);
    // The first run's greeting answers as its step asks; the second's
    // doesn't, and its run fails at the greeting.
    await providerAnswering(
      answer('{"line":"Hello Ada"}'),
      answer("Hello, Ada!")
    );
    const completed = await ended(
      ada,
      workflow.id,
      await started(ada, workflow.id)
    );
    const failed = await ended(
      ada,
      workflow.id,
      await started(ada, workflow.id)
    );
    const spent = await env.DB.prepare(
      "SELECT run_id AS run, sum(cost) AS cost FROM model_usage WHERE workflow_id = ? GROUP BY run_id"
    )
      .bind(workflow.id)
      .all<{ run: string; cost: number }>();
    const costOf = (run: string): number =>
      spent.results.find((row) => row.run === run)?.cost ?? 0;

    await refreshDailySignals(env, computedOn(25));
    const { api } = await signedInApi(idp, "admin");
    const { signals } = await api.signals.list();

    const total = costOf(completed.id) + costOf(failed.id);
    expect(costOf(completed.id)).toBeGreaterThan(0);
    expect({
      ends: [endOf(completed).status, endOf(failed).status],
      failing: signalsOf(signals, "failing_step", workflow.name),
      cost: signalsOf(signals, "cost_per_run", workflow.name),
    }).toStrictEqual({
      ends: ["completed", "failed"],
      failing: [
        {
          kind: "failing_step",
          app: null,
          workflow: workflow.name,
          subject: "greet",
          value: 1,
          evidence: {
            failures: 1,
            runs: 2,
            errors: [{ code: failed.error?.code, count: 1 }],
            recent: [failed.id],
          },
        },
      ],
      cost: [
        {
          kind: "cost_per_run",
          app: null,
          workflow: workflow.name,
          subject: null,
          value: rounded(total / 2),
          evidence: {
            runs: 2,
            cost: rounded(total),
            costliest: [completed, failed]
              .map(({ id }) => ({ run: id, cost: rounded(costOf(id)) }))
              .toSorted(
                (a, b) => b.cost - a.cost || a.run.localeCompare(b.run)
              ),
          },
        },
      ],
    });
  });

  it("blame no task for a run that failed outside every step, after a task whose failure a catch took", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    // Its opening greeting's step fails (its answer is off its schema), and
    // a catch takes that; its greeting runs and ends well; then the
    // condition of an `if`, outside any step, fails, and the run with it.
    const { workflow } = await greetingWorkflow(ada, admin, {
      before: [
        {
          id: "opening",
          type: "try",
          try: [greetStep("first")],
          catch: {},
        },
      ],
      after: [
        {
          id: "check",
          type: "if",
          condition: { $expr: `${failing} === "A"` },
          // oxlint-disable-next-line unicorn/no-thenable -- the if step's list
          then: [{ id: "never", type: "wait", for: "1 second" }],
        },
      ],
    });
    await providerAnswering(
      answer("Hello, Ada!"),
      answer('{"line":"Hello Ada"}')
    );
    const failed = await ended(
      ada,
      workflow.id,
      await started(ada, workflow.id)
    );

    await refreshDailySignals(env, computedOn(26));
    const { api } = await signedInApi(idp, "admin");
    const { signals } = await api.signals.list();

    expect({
      end: endOf(failed),
      failing: signalsOf(signals, "failing_step", workflow.name).map(
        ({ subject, evidence }) => ({ subject, errors: evidence.errors })
      ),
    }).toStrictEqual({
      end: { status: "failed", code: "expression.failed" },
      failing: [
        { subject: null, errors: [{ code: "expression.failed", count: 1 }] },
      ],
    });
  });
});
