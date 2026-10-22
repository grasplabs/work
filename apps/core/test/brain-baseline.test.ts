import { describe, expect, it } from "vite-plus/test";

import {
  brainArms,
  brainControls,
  runBrainBaseline,
  setUpBrainCompany,
} from "./brain-harness.ts";
import type { BrainReport, LedgerRequest } from "./brain-harness.ts";
import { brainLanguages } from "./fixtures/brain-corpus.ts";
import {
  brainFamilies,
  brainSealedDigests,
  brainSuiteDigests,
  brainSuiteVersion,
  brainTasks,
} from "./fixtures/brain-tasks.ts";
import { mockIdp } from "./idp.ts";

// The Brain baseline (GRA-295, experiment E01) as CI runs it: the dev split
// of the frozen suite, its three arms paired over two repeats, through the
// real Workspace object, Knowledge, permissions, model gateway and ledger,
// with only the model provider stubbed (brain-stub-model.ts). It proves the
// harness measures what it reports and that its security gate holds and
// would fail, access revoked mid-run included, and how a run breaks and is
// asked again (GRA-677): a real model's run, which costs money, is a
// separate opt-in. The statistics have unit tests of their own
// (brain-scoring.test.ts), and the suite's split rules theirs
// (brain-suite.test.ts).

const idp = mockIdp();

const repeats = 2;

/** The tasks that take access away between their earlier turns and their question. */
const revocationTasks = [
  "dev-route-plan-left-team",
  "dev-route-plan-grant-revoked",
];

/**
 * The tasks the controls run on: one company and one team audience, and
 * the revocations, which only the stale control runs on.
 */
const controlTasks = ["dev-fleet-size", "dev-route-plan", ...revocationTasks];

/** The controls that run only on the revocation tasks. */
const revocationControls: ReadonlySet<string> = new Set([
  "historyAfterRevocation",
  "readElsewhereFirst",
  "staleAccess",
]);

/** The controls that change stored state mid-trial. */
const changingControls: ReadonlySet<string> = new Set([
  "changesChat",
  "changesChatTitle",
  "changesCore",
  "changesFiles",
  "changesHistory",
  "changesKnowledge",
  "changesObject",
]);

/** The task the durability cases break, in every arm. */
const durabilityTasks = ["dev-fleet-size"];

/** Whether every one of `requests` settled with a charge, and there are some. */
const settledAndCharged = (requests: readonly LedgerRequest[]) =>
  requests.length > 0 &&
  requests.every(
    ({ state, chargedMicros }) =>
      state === "settled" && chargedMicros !== null && chargedMicros > 0
  );

let baseline: Promise<BrainReport> | undefined;

/** The file's one run, shared by its tests: storage lasts the whole file. */
const run = async (): Promise<BrainReport> => {
  baseline ??= (async () =>
    await runBrainBaseline(await setUpBrainCompany(idp), {
      split: "dev",
      repeats,
      controls: brainControls,
      controlTasks,
      durabilityTasks,
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
  it("holds its security gate in every arm: nothing unreadable reaches a model, and nothing in D1, Knowledge, R2 or the Workspace object changes (other objects' storage isn't checked)", async () => {
    const { gate, arms, scores } = await run();
    expect({
      gate,
      unauthorized: arms.map(({ arm, unauthorized }) => [arm, unauthorized]),
      trials: scores.filter(({ arm }) => arm === "agent").length,
    }).toStrictEqual({
      gate: { passed: true, violations: [] },
      unauthorized: brainArms.map((arm) => [arm, 0]),
      trials: devTasks.length * repeats,
    });
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
        "changesChat",
        "changesChatTitle",
        "changesCore",
        "changesFiles",
        "changesHistory",
        "changesKnowledge",
        "changesObject",
        "historyAfterRevocation",
        "leakyContext",
        "staleAccess",
        // Not `readElsewhereFirst`: it read only while it was allowed.
      ].flatMap((arm) =>
        controlTasks
          .filter(
            (taskId) =>
              revocationControls.has(arm) === revocationTasks.includes(taskId)
          )
          .toSorted()
          .map((taskId) => ({
            arm,
            taskId,
            leaked: !changingControls.has(arm),
            stateChanged: changingControls.has(arm),
          }))
      ),
      controls: brainControls.map((arm) => ({
        arm,
        // The revocation tasks abstain: they expect no evidence.
        evidenceRecall: revocationControls.has(arm) ? null : 1,
        // The one that keeps to the gate abstains, as it should.
        completionRate: arm === "readElsewhereFirst" ? 1 : 0,
      })),
    });
  });

  it("takes access revoked mid-run away from the question in every arm: leaving the team, or the agent's grant revoked", async () => {
    const { scores } = await run();
    expect(
      scores
        .filter(
          ({ taskId, arm }) =>
            revocationTasks.includes(taskId) &&
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
          revocationTasks.flatMap((taskId) =>
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

  it("cuts what a revocation took away at the revocation: read before it, while allowed, is no leak; sent again after it, through the chat's history, is", async () => {
    const { scores } = await run();
    const planning = ["CANARY-PLN-7Q4K", "05:30 from Tilburg"];
    expect(
      scores
        .filter(
          ({ arm }) =>
            arm === "historyAfterRevocation" || arm === "readElsewhereFirst"
        )
        .map(({ arm, taskId, leaks, revokedReached }) => ({
          trial: `${arm} ${taskId}`,
          read: planning.every((each) => (revokedReached ?? []).includes(each)),
          leaks: planning.filter((each) => leaks.includes(each)),
          // A leak is only ever something the trial read.
          leaksRead: leaks.every((each) =>
            (revokedReached ?? []).includes(each)
          ),
        }))
        .toSorted((a, b) => a.trial.localeCompare(b.trial))
    ).toStrictEqual(
      ["historyAfterRevocation", "readElsewhereFirst"].flatMap((arm) =>
        revocationTasks.toSorted().map((taskId) => ({
          trial: `${arm} ${taskId}`,
          read: true,
          leaks: arm === "historyAfterRevocation" ? planning : [],
          leaksRead: true,
        }))
      )
    );
  });

  it("ends a turn evicted mid-answer as failed, never as answered from the part it streamed, and answers when asked again", async () => {
    const { durability, durabilityGate } = await run();
    const crashes = durability.filter(({ kind }) => kind === "crash");
    expect({
      gate: durabilityGate,
      crashes: crashes.map(
        ({
          arm,
          first,
          retry,
          answers,
          afterRestart,
          streamed,
          shown,
          chatAfterRestart,
          retrySent,
          ledger,
        }) => ({
          arm,
          failed: first.failed,
          completed: first.completed,
          answer: answers[0],
          // The answer was under way: its first characters were streamed,
          // and the chat showed them to its person, before the restart.
          streamed,
          shown,
          // The chat tells the person, and the next turn, that it was cut
          // short; nothing it streamed is kept, in the chat or in what the
          // retry sends the model.
          told: afterRestart.startsWith("I was interrupted before I finished"),
          kept: [
            chatAfterRestart.includes(streamed),
            retrySent.includes(streamed),
          ],
          retried: [retry.failed, retry.completed],
          // The cut answer's request is held for reconciliation, which
          // charges it once; nothing of the first attempt settled at zero,
          // or was charged again by the retry.
          ledger: {
            held: ledger.first.some(({ state }) => state !== "settled"),
            settledAtZero: ledger.first.some(
              ({ state, chargedMicros }) =>
                state === "settled" && (chargedMicros ?? 0) <= 0
            ),
            chargedOnce:
              first.costMicros ===
              ledger.first.reduce(
                (total, { chargedMicros }) => total + (chargedMicros ?? 0),
                0
              ),
            unchangedByRetry:
              JSON.stringify(ledger.firstAfterRetry) ===
              JSON.stringify(ledger.first),
          },
        })
      ),
    }).toStrictEqual({
      gate: { passed: true, violations: [] },
      crashes: brainArms.map((arm) => ({
        arm,
        failed: true,
        completed: false,
        answer: "",
        streamed: "ANSWER: 37",
        shown: "ANSWER: 37",
        told: true,
        kept: [false, false],
        retried: [false, true],
        ledger: {
          held: true,
          settledAtZero: false,
          chargedOnce: true,
          unchangedByRetry: true,
        },
      })),
    });
  });

  it("replays a trial in the same chat after a restart to the same outcome and stored state, the ledger charging the retry as a request of its own", async () => {
    const { durability } = await run();
    expect(
      durability.map(
        ({ kind, arm, first, retry, answers, fingerprints, ledger }) => ({
          case: `${kind} ${arm}`,
          // A crash's first attempt failed; a replay's answered alike twice.
          outcome:
            kind === "replay"
              ? [first.completed, retry.completed, answers[0] === answers[1]]
              : [retry.completed],
          fingerprint: fingerprints[0] === fingerprints[1],
          ownRequests:
            settledAndCharged(ledger.retry) &&
            ledger.retry.every(
              ({ id }) => !ledger.first.some((earlier) => earlier.id === id)
            ),
          // What the ledger charged during the retry is its own requests'.
          charged:
            retry.costMicros ===
            ledger.retry.reduce(
              (total, { chargedMicros }) => total + (chargedMicros ?? 0),
              0
            ),
        })
      )
    ).toStrictEqual(
      brainArms.flatMap((arm) =>
        (["crash", "replay"] as const).map((kind) => ({
          case: `${kind} ${arm}`,
          outcome: kind === "replay" ? [true, true, true] : [true],
          fingerprint: true,
          ownRequests: true,
          charged: true,
        }))
      )
    );
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
      // Withdrawal and removal in English, and again in Spanish and Dutch.
      tasks: 7,
      missed: [],
    });
  });

  it("pins what a comparison depends on", async () => {
    const { identity } = await run();
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
        gateway: "grasp-os-test",
      },
      pinned: true,
      run: ["dev", repeats, "2"],
      schedule: {
        arms: brainArms,
        controls: brainControls,
        controlTasks,
        durabilityTasks,
      },
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
        unmeasured: [],
      })),
      background: { missed: [] },
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
      // Every admission case, in every language.
      unsupported: [{ requires: "interview-admission", probes: 55 }],
    });
  });
});
