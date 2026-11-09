/**
 * The Brain baseline (GRA-295, experiment E01) in parts, as CI runs it.
 * One run of the whole dev split, its three arms paired over two repeats,
 * took close to three minutes in CI: more than a shard should wait for one
 * file. So each part of the split's tasks runs in a file of its own
 * (brain-baseline-<n>-of-4.test.ts), on a company of its own, the whole suite
 * loaded, updated window by window and pinned as in one run; and the
 * controls and durability cases, which run after the measured trials and
 * need none of them, run in brain-baseline.test.ts, which also checks that
 * the parts together are the whole split.
 *
 * Each trial already checks that it left every stored row as it found it,
 * one at a time: a part holds the gate alone as it did beside the others.
 * The comparisons are paired by task, so each part pairs its own tasks.
 */
import { describe, expect, it } from "vite-plus/test";

import { filePart } from "../../../scripts/test-file-parts.ts";
import type { FilePart } from "../../../scripts/test-file-parts.ts";
import {
  brainArms,
  runBrainBaseline,
  setUpBrainCompany,
} from "./brain-harness.ts";
import type { BrainControl, BrainReport } from "./brain-harness.ts";
import {
  brainSealedDigests,
  brainSuiteDigests,
  brainSuiteVersion,
  brainTasks,
} from "./fixtures/brain-tasks.ts";
import { mockIdp } from "./idp.ts";
import type { Idp } from "./idp.ts";

export const repeats = 2;

/** Each test of a file may wait for its run: the whole run, at worst. */
export const baselineTimeout = 300_000;

/** The tasks that take access away between their earlier turns and their question. */
export const revocationTasks = [
  "dev-route-plan-left-team",
  "dev-route-plan-grant-revoked",
];

/**
 * The parts of the dev split, a file each (brain-baseline-<n>-of-4.test.ts),
 * of eight or nine tasks. Each part is the whole split in small, so each
 * holds its arms to the budgets as the whole run did: a task its person
 * may not read; one asking what changed (corrected, withdrawn, removed or
 * owned by someone else since); a count of five or six contributors, which retrieval's
 * five sections can't hold, and one of four; and tasks of later windows.
 * Their trials take about as long in each: the tasks with earlier turns,
 * the revocations among them, are spread out.
 */
export const brainBaselineParts = [
  [
    "dev-route-plan",
    "dev-route-plan-left-team",
    "dev-locker",
    "dev-fleet-size",
    "dev-travel-corrected",
    "dev-health-check-benign",
    "dev-supplier-contact",
    "dev-survey-lighting",
    "dev-survey-parking",
  ],
  [
    "dev-route-plan-outsider",
    "dev-route-plan-grant-revoked",
    "dev-locker-other-person",
    "dev-travel-rate",
    "dev-fleet-order",
    "dev-forklift-benign",
    "dev-supplier-contact-removed",
    "dev-survey-schedule",
    "dev-survey-lighting-withdrawn",
  ],
  [
    "dev-session-reference",
    "dev-session-other-chat",
    "dev-office-days-planning",
    "dev-office-days-company",
    "dev-container-pay-benign",
    "dev-supplier-contact-removed-nl",
    "dev-contract-owner-january",
    "dev-survey-lighting-nl",
    "dev-survey-parking-de",
  ],
  [
    "dev-salary-sensitive",
    "dev-parking-conflict",
    "dev-pension-empty",
    "dev-supplier-delivery",
    "dev-night-loading",
    "dev-contract-owner-october",
    "dev-survey-schedule-fr",
    "dev-survey-lighting-withdrawn-es",
  ],
] as const satisfies readonly (readonly string[])[];

/** The split's one empty result: only its part measures abstaining on one. */
const emptyTask = "dev-pension-empty";

/**
 * The budgets the arms of a run of `tasks` measure nothing for: abstaining
 * on an empty result, unless the empty one is among them.
 */
export const unmeasuredIn = (tasks: readonly string[]): string[] =>
  tasks.includes(emptyTask) ? [] : ["quality.abstains-on-empty"];

/**
 * A baseline run of `tasks`, with `controls` on `controlTasks` and the
 * durability cases on `durabilityTasks` after them, started by the first
 * test that asks for it and shared by the others: storage lasts the whole
 * file.
 */
export const brainBaselineRun = (
  idp: Idp,
  {
    tasks,
    controls = [],
    controlTasks = [],
    durabilityTasks = [],
  }: {
    tasks: readonly string[];
    controls?: readonly BrainControl[];
    controlTasks?: readonly string[];
    durabilityTasks?: readonly string[];
  }
): (() => Promise<BrainReport>) => {
  let report: Promise<BrainReport> | undefined;
  return async () => {
    report ??= (async () =>
      await runBrainBaseline(await setUpBrainCompany(idp), {
        split: "dev",
        tasks,
        repeats,
        controls,
        controlTasks,
        durabilityTasks,
      }))();
    return await report;
  };
};

/** How often each of `values` occurs. */
const tally = (values: readonly string[]): Record<string, number> =>
  Object.fromEntries(
    [...new Set(values)].map((value) => [
      value,
      values.filter((each) => each === value).length,
    ])
  );

/**
 * The part of the baseline the file `file` (a path or URL) runs, from its
 * own name: `brain-baseline-<part>-of-<parts>.test.ts`
 * (scripts/test-file-parts.ts), `parts` the number of
 * `brainBaselineParts`. brain-baseline.test.ts reads every such file's
 * name and checks that together they measure the whole split, each task
 * once.
 */
export const baselinePart = (
  file: string
): FilePart & { tasks: readonly string[] } => {
  const named = filePart(file);
  const { run, part, parts } = named;
  const tasks = brainBaselineParts.at(part - 1);
  if (
    run !== "brain-baseline" ||
    parts !== brainBaselineParts.length ||
    tasks === undefined
  ) {
    throw new RangeError(
      `${run}-${part}-of-${parts} isn't a part of the baseline: brain-baseline-<part>-of-${brainBaselineParts.length}.test.ts`
    );
  }
  return { ...named, tasks };
};

/** What a part of the baseline, `tasks`, must show of them. */
const baselinePartTests = (idp: Idp, tasks: readonly string[]): void => {
  const run = brainBaselineRun(idp, { tasks });
  // In the suite's order, as the run takes them.
  const measured = brainTasks.filter(({ id }) => tasks.includes(id));
  const revoking = revocationTasks.filter((id) => tasks.includes(id));

  it("holds its security gate in every arm: nothing unreadable reaches a model, and nothing in D1, Knowledge, R2 or the Workspace object changes (other objects' storage isn't checked)", async () => {
    const { gate, arms, scores } = await run();
    expect({
      gate,
      unauthorized: arms.map(({ arm, unauthorized }) => [arm, unauthorized]),
      trials: scores.filter(({ arm }) => arm === "agent").length,
    }).toStrictEqual({
      gate: { passed: true, violations: [] },
      unauthorized: brainArms.map((arm) => [arm, 0]),
      trials: tasks.length * repeats,
    });
  });

  if (revoking.length > 0) {
    it("takes access revoked mid-run away from the question in every arm: leaving the team, or the agent's grant revoked", async () => {
      const { scores } = await run();
      expect(
        scores
          .filter(
            ({ taskId, arm }) =>
              revoking.includes(taskId) &&
              brainArms.some((each) => each === arm)
          )
          .map(
            ({
              arm,
              taskId,
              repeat,
              leaks,
              revokedReached,
              stateChanged,
              completed,
            }) => ({
              trial: `${arm} ${taskId} ${repeat}`,
              leaks,
              revokedReached,
              stateChanged,
              completed,
            })
          )
          .toSorted((a, b) => a.trial.localeCompare(b.trial))
      ).toStrictEqual(
        brainArms
          .flatMap((arm) =>
            revoking.flatMap((taskId) =>
              Array.from({ length: repeats }, (_, index) => ({
                trial: `${arm} ${taskId} ${index + 1}`,
                leaks: [],
                // Its earlier turns read nothing: nothing revoked ever reached it.
                revokedReached: [],
                stateChanged: false,
                // It abstains: what it could have read earlier is gone.
                completed: true,
              }))
            )
          )
          .toSorted((a, b) => a.trial.localeCompare(b.trial))
      );
    });
  }

  it("answers from the corpus as it stands: corrected, withdrawn and removed content never comes back", async () => {
    const { scores } = await run();
    const current = measured
      .filter(({ family }) =>
        [
          "correction",
          "withdrawal",
          "removal",
          "historical-ownership",
        ].includes(family)
      )
      .map(({ id }) => id);
    expect({
      // Every part has some: brain-baseline.test.ts counts them all.
      some: current.length > 0,
      missed: scores
        .filter(
          ({ taskId, completed }) => current.includes(taskId) && !completed
        )
        .map(({ arm, taskId }) => `${arm} ${taskId}`),
    }).toStrictEqual({ some: true, missed: [] });
  });

  it("pins what a comparison depends on, the tasks it measured among them", async () => {
    const { identity, coverage } = await run();
    const digest = /^[0-9a-f]{64}$/u;
    expect({
      suite: identity.suite.version,
      digest: identity.suite.digest,
      sealed: identity.suite.sealedDigest,
      // The corpus changes in each window, and each snapshot is recorded.
      windows: new Set(Object.values(identity.sources)).size,
      retrieval: Object.keys(identity.retrieval),
      // One tool contract, and one set of instructions and API
      // declarations, across every arm, person and repeat.
      tools: identity.tools.length,
      prompt: identity.prompt.length,
      model: identity.model,
      pinned: [identity.skills, identity.policy].every((value) =>
        digest.test(value)
      ),
      run: [identity.split, identity.repeats, identity.harness],
      schedule: identity.schedule,
      families: coverage.families,
      languages: coverage.languages,
    }).toStrictEqual({
      suite: brainSuiteVersion,
      digest: brainSuiteDigests[brainSuiteVersion],
      sealed: brainSealedDigests[brainSuiteVersion],
      windows: 3,
      retrieval: ["t0", "t1", "t2"],
      tools: 1,
      prompt: 1,
      model: {
        id: "anthropic/claude-sonnet-4-5",
        provider: "brain-stub-reader/2026-10-15",
      },
      pinned: true,
      run: ["dev", repeats, "8"],
      schedule: {
        tasks: measured.map(({ id }) => id),
        arms: brainArms,
        controls: [],
        controlTasks: [],
        durabilityTasks: [],
      },
      families: tally(measured.map(({ family }) => family)),
      languages: tally(measured.map(({ language }) => language)),
    });
  });

  it("compares the arms paired by task, with an interval and the tasks a decision would need", async () => {
    const { arms, comparisons } = await run();
    const fullContext = arms.find(({ arm }) => arm === "fullContext");
    expect({
      // Every readable section reached the model in the full-context arm.
      fullContext: [fullContext?.evidenceRecall, fullContext?.completionRate],
      // The stub answers alike every time: no noise between repeats.
      noise: arms.map(({ repeatDisagreement }) => repeatDisagreement),
      pairs: comparisons.map(({ candidate, baseline, tasks: paired }) => [
        candidate,
        baseline,
        paired,
      ]),
      bounded: comparisons.every(
        ({ meanDifference, interval: [low, high], requiredTasks }) =>
          low <= meanDifference && meanDifference <= high && requiredTasks >= 2
      ),
    }).toStrictEqual({
      fullContext: [1, 1],
      noise: [0, 0, 0],
      pairs: [
        ["fullContext", "agent", tasks.length],
        ["fullText", "agent", tasks.length],
        ["fullContext", "fullText", tasks.length],
      ],
      bounded: true,
    });
  });

  it("measures cold and warm latency, and what each trial cost", async () => {
    const { arms, costs, scores } = await run();
    expect({
      latency: arms.map(
        ({ latencyMs }) =>
          latencyMs.coldP95 !== null && latencyMs.warmP95 !== null
      ),
      // Every trial cost something, through the gateway.
      charged: scores.every(({ costMicros }) => costMicros > 0),
      perCompleted: arms.map(
        ({ cost }) => cost.totalMicros > 0 && cost.perCompletedMicros !== null
      ),
      // Full-text indexing needs no model, and the baseline learns nothing.
      build: costs.build.costMicros,
      updates: costs.updates.map(({ window, costMicros }) => [
        window,
        costMicros,
      ]),
      learning: costs.learningMicros,
    }).toStrictEqual({
      latency: [true, true, true],
      charged: true,
      perCompleted: [true, true, true],
      build: 0,
      updates: [
        ["t1", 0],
        ["t2", 0],
      ],
      learning: 0,
    });
  });

  it("holds every arm to the proposed budgets: none misses a security budget, and what the stub can't meet is named", async () => {
    const { budgets } = await run();
    expect(budgets).toStrictEqual({
      arms: brainArms.map((arm) => ({
        arm,
        hardMissed: [],
        // Retrieval reads five sections: the agent and full-text arms
        // abstain on the five- and six-contributor counts, in each language
        // they are asked in. Every section reaches full context.
        missed: arm === "fullContext" ? [] : ["quality.over-abstention"],
        unmeasured: unmeasuredIn(tasks),
      })),
      background: { missed: [] },
    });
  });
};

/**
 * What a part of the baseline must show of its own tasks, from a run of
 * them on a company of its own: the part the file `file` (its
 * `import.meta.url`) names (`baselinePart`).
 */
export const baselinePartFile = (file: string): void => {
  const { part, parts, tasks } = baselinePart(file);
  const idp = mockIdp();
  describe(
    `the Brain baseline: part ${part} of ${parts}`,
    { timeout: baselineTimeout },
    () => {
      baselinePartTests(idp, tasks);
    }
  );
};
