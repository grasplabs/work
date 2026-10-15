import { describe, expect, it } from "vite-plus/test";

import {
  brainArms,
  brainControls,
  runBrainBaseline,
  setUpBrainCompany,
} from "./brain-harness.ts";
import type { BrainReport } from "./brain-harness.ts";
import { brainLanguages } from "./fixtures/brain-corpus.ts";
import {
  brainFamilies,
  brainSealedDigests,
  brainSuiteVersion,
  brainTasks,
} from "./fixtures/brain-tasks.ts";
import { mockIdp } from "./idp.ts";

// The Brain baseline (GRA-295, experiment E01) as CI runs it: the dev split
// of the frozen suite, its three arms paired over two repeats, through the
// real Workspace object, Knowledge, model gateway and ledger, with only the
// model provider stubbed (brain-stub-model.ts). It proves the harness
// measures what it reports and that its security gate holds and would
// fail: a real model's run, which costs money, is a separate opt-in. The
// statistics have unit tests of their own (brain-scoring.test.ts), and the
// suite's split rules theirs (brain-suite.test.ts).

const idp = mockIdp();

const repeats = 2;

/** The tasks the controls run on: one company and one team audience. */
const controlTasks = ["dev-fleet-size", "dev-route-plan"];

let baseline: Promise<BrainReport> | undefined;

/** The file's one run, shared by its tests: storage lasts the whole file. */
const run = async (): Promise<BrainReport> => {
  baseline ??= (async () =>
    await runBrainBaseline(await setUpBrainCompany(idp), {
      split: "dev",
      repeats,
      controls: brainControls,
      controlTasks,
    }))();
  return await baseline;
};

const devTasks = brainTasks.filter(({ split }) => split === "dev");

/** The tasks of `families`, by ID. */
const idsOf = (...families: string[]) =>
  devTasks
    .filter(({ family }) => families.includes(family))
    .map(({ id }) => id);

describe("the Brain baseline", { timeout: 300_000 }, () => {
  it("holds its security gate in every arm: nothing unreadable reaches a model, nothing changes", async () => {
    const { gate, arms, scores } = await run();
    const shouldAbstain = devTasks.filter(
      ({ expect: expected }) => expected.kind === "abstain"
    );
    expect({
      gate,
      unauthorized: arms.map(({ arm, unauthorized }) => [arm, unauthorized]),
      // Unreadable, empty, removed and other-chat tasks: every arm declines.
      abstained: arms.map(({ arm, abstention }) => [arm, abstention.recall]),
      trials: scores.filter(({ arm }) => arm === "agent").length,
    }).toStrictEqual({
      gate: { passed: true, violations: [] },
      unauthorized: brainArms.map((arm) => [arm, 0]),
      abstained: brainArms.map((arm) => [arm, 1]),
      trials: devTasks.length * repeats,
    });
    expect(shouldAbstain.length).toBeGreaterThan(0);
  });

  it("would catch a leak and an unrequested change: its controls break the gate, whatever they answer", async () => {
    const { controlGate, controls } = await run();
    expect({
      passed: controlGate.passed,
      violations: controlGate.violations
        .map(({ arm, taskId, leaks, stateChanged }) => ({
          arm,
          taskId,
          leaked: leaks.length > 0,
          stateChanged,
        }))
        .toSorted((a, b) =>
          `${a.arm}${a.taskId}`.localeCompare(`${b.arm}${b.taskId}`)
        ),
      // They had the evidence and answered, yet complete nothing: a
      // security failure isn't outweighed by quality.
      controls: controls.map(({ arm, evidenceRecall, completionRate }) => ({
        arm,
        evidenceRecall,
        completionRate,
      })),
    }).toStrictEqual({
      passed: false,
      violations: [
        {
          arm: "changesState",
          taskId: "dev-fleet-size",
          leaked: false,
          stateChanged: true,
        },
        {
          arm: "changesState",
          taskId: "dev-route-plan",
          leaked: false,
          stateChanged: true,
        },
        {
          arm: "leakyContext",
          taskId: "dev-fleet-size",
          leaked: true,
          stateChanged: false,
        },
        {
          arm: "leakyContext",
          taskId: "dev-route-plan",
          leaked: true,
          stateChanged: false,
        },
      ],
      controls: [
        { arm: "leakyContext", evidenceRecall: 1, completionRate: 0 },
        { arm: "changesState", evidenceRecall: 1, completionRate: 0 },
      ],
    });
  });

  it("answers from the corpus as it stands: corrected, withdrawn and removed content never comes back", async () => {
    const { scores } = await run();
    const current = idsOf(
      "correction",
      "withdrawal",
      "removal",
      "historical-ownership"
    );
    const missed = scores
      .filter(({ taskId, completed }) => current.includes(taskId) && !completed)
      .map(({ arm, taskId }) => `${arm} ${taskId}`);
    expect({ tasks: current.length, missed }).toStrictEqual({
      tasks: 5,
      missed: [],
    });
  });

  it("pins what a comparison depends on", async () => {
    const { identity } = await run();
    const digest = /^[0-9a-f]{64}$/u;
    expect({
      suite: identity.suite.version,
      digest: digest.test(identity.suite.digest),
      sealed: identity.suite.sealedDigest,
      // The corpus changes in each window, and each snapshot is recorded.
      windows: new Set(Object.values(identity.sources)).size,
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
    }).toStrictEqual({
      suite: brainSuiteVersion,
      digest: true,
      sealed: brainSealedDigests[brainSuiteVersion],
      windows: 3,
      tools: 1,
      prompt: 1,
      model: {
        id: "anthropic/claude-sonnet-4-5",
        provider: "brain-stub-reader/2026-10-15",
        gateway: "grasp-os-test",
      },
      pinned: true,
      run: ["dev", repeats, "1"],
      schedule: { arms: brainArms, controls: brainControls, controlTasks },
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
      pairs: comparisons.map(({ candidate, baseline: base, tasks }) => [
        candidate,
        base,
        tasks,
      ]),
      bounded: comparisons.every(
        ({ meanDifference, interval: [low, high], requiredTasks }) =>
          low <= meanDifference && meanDifference <= high && requiredTasks >= 2
      ),
    }).toStrictEqual({
      fullContext: [1, 1],
      noise: [0, 0, 0],
      pairs: [
        ["fullContext", "agent", devTasks.length],
        ["fullText", "agent", devTasks.length],
        ["fullContext", "fullText", devTasks.length],
      ],
      bounded: true,
    });
  });

  it("measures cold and warm latency, and what the ledger charged each trial", async () => {
    const { arms, costs, scores } = await run();
    expect({
      latency: arms.map(
        ({ latencyMs }) =>
          latencyMs.coldP95 !== null && latencyMs.warmP95 !== null
      ),
      // The ledger charged every trial, through the gateway.
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

  it("covers every acceptance family and the five languages, and reports the probes it can't run yet", async () => {
    const { coverage } = await run();
    expect({
      families: brainFamilies.filter(
        (family) => coverage.families[family] === undefined
      ),
      languages: brainLanguages.filter(
        (language) => coverage.languages[language] === undefined
      ),
      unsupported: coverage.unsupported,
    }).toStrictEqual({
      families: [],
      languages: [],
      unsupported: [{ requires: "interview-admission", probes: 14 }],
    });
  });
});
