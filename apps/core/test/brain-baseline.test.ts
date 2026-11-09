import { describe, expect, it } from "vite-plus/test";

import {
  baselineTimeout,
  brainBaselineParts,
  brainBaselineRun,
  repeats,
  revocationTasks,
  unmeasuredIn,
} from "./brain-baseline-parts.ts";
import { brainArms, brainControls } from "./brain-harness.ts";
import type { RecordedRequest } from "./brain-harness.ts";
import { brainProposedBudgets } from "./brain-scoring.ts";
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
// real Workspace object, Knowledge, permissions, model gateway and usage,
// with only the model provider stubbed (brain-stub-model.ts). It proves the
// harness measures what it reports and that its security gate holds and
// would fail, access revoked mid-run included, and how a run breaks and is
// asked again (GRA-677): a real model's run, which costs money, is a
// separate opt-in. The measured trials run in parts, a file each
// (brain-baseline-parts.ts); this file runs the controls and the
// durability cases, after no measured trial, on the suite as the last
// window left it, and checks that the parts are the whole split. The
// statistics have unit tests of their own (brain-scoring.test.ts), and the
// suite's split rules theirs (brain-suite.test.ts).

const idp = mockIdp();

/** How often `part` occurs in `text`. */
const count = (text: string, part: string): number =>
  text.split(part).length - 1;

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
  "changesCapture",
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

/** Whether every one of `requests` was recorded with a cost, and there are some. */
const recordedWithCost = (requests: readonly RecordedRequest[]) =>
  requests.length > 0 &&
  requests.every(({ chargedMicros }) => chargedMicros > 0);

/** The file's one run, shared by its tests: no measured trial, only the controls and durability cases. */
const run = brainBaselineRun(idp, {
  tasks: [],
  controls: brainControls,
  controlTasks,
  durabilityTasks,
});

const devTasks = brainTasks.filter(({ split }) => split === "dev");

/** The tasks of `families`, by ID. */
const idsOf = (...families: string[]) =>
  devTasks
    .filter(({ family }) => families.includes(family))
    .map(({ id }) => id);

/** Every task the parts measure, as many times as they do. */
const partTasks: readonly string[] = brainBaselineParts.flat();

describe("the Brain baseline", { timeout: baselineTimeout }, () => {
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
        "changesCapture",
        "changesChat",
        "changesChatTitle",
        "changesCore",
        "changesFiles",
        "changesHistory",
        "changesKnowledge",
        "changesObject",
        "leakyContext",
        "staleAccess",
        // Not `readElsewhereFirst`: it read only while it was allowed. Nor
        // `historyAfterRevocation`: the chat withholds what it read from
        // every request after the revocation (GRA-690).
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
        // Those that keep to the gate abstain, as they should.
        completionRate:
          arm === "readElsewhereFirst" || arm === "historyAfterRevocation"
            ? 1
            : 0,
      })),
    });
  });

  it("cuts what a revocation took away at the revocation: read before it, while allowed, is no leak, and the chat's history never sends it again after it", async () => {
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
          leaks: [],
          leaksRead: true,
        }))
      )
    );
  });

  it("fails the ask a restart cut off mid-answer, goes on with its turn to the whole answer, never the part it streamed, and answers when asked again", async () => {
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
          recorded,
        }) => ({
          arm,
          // The ask the restart cut off fails: its asker is gone.
          failed: first.failed,
          completed: first.completed,
          answer: answers[0],
          // The answer was under way: its first characters were streamed,
          // and the chat showed them to its person, before the restart.
          streamed,
          shown,
          // The chat's own object goes on with the turn as it wakes: asked
          // for again, the whole answer, as asking again gives.
          resumed: afterRestart === answers[1],
          // What it streamed is kept only as the start of a whole answer,
          // never on its own, in the chat or in what the retry sends the
          // model.
          kept: [
            count(chatAfterRestart, streamed) ===
              count(
                chatAfterRestart,
                JSON.stringify(afterRestart).slice(1, -1)
              ),
            count(retrySent, streamed) === count(retrySent, afterRestart),
          ],
          retried: [retry.failed, retry.completed],
          // What the first attempt cost is what was recorded of its requests
          // (the cut answer's record is best effort); nothing of the first
          // attempt is recorded again by the retry.
          recorded: {
            chargedOnce:
              first.costMicros ===
              recorded.first.reduce(
                (total, { chargedMicros }) => total + chargedMicros,
                0
              ),
            unchangedByRetry:
              JSON.stringify(recorded.firstAfterRetry) ===
              JSON.stringify(recorded.first),
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
        resumed: true,
        kept: [true, true],
        retried: [false, true],
        recorded: {
          chargedOnce: true,
          unchangedByRetry: true,
        },
      })),
    });
  });

  it("replays a trial in the same chat after a restart to the same outcome and stored state, the retry recorded as requests of its own", async () => {
    const { durability } = await run();
    expect(
      durability.map(
        ({ kind, arm, first, retry, answers, fingerprints, recorded }) => ({
          case: `${kind} ${arm}`,
          // A crash's first attempt failed; a replay's answered alike twice.
          outcome:
            kind === "replay"
              ? [first.completed, retry.completed, answers[0] === answers[1]]
              : [retry.completed],
          fingerprint: fingerprints[0] === fingerprints[1],
          ownRequests:
            recordedWithCost(recorded.retry) &&
            recorded.retry.every(
              ({ id }) => !recorded.first.some((earlier) => earlier.id === id)
            ),
          // What was spent during the retry is its own requests'.
          charged:
            retry.costMicros ===
            recorded.retry.reduce(
              (total, { chargedMicros }) => total + chargedMicros,
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
      },
      pinned: true,
      run: ["dev", repeats, "8"],
      schedule: {
        tasks: [],
        arms: brainArms,
        controls: brainControls,
        controlTasks,
        durabilityTasks,
      },
    });
  });

  it("measures the whole dev split in its parts, each task in one part, every family and language among them, and reports the probes it can't run yet", async () => {
    const { coverage } = await run();
    const current = idsOf(
      "correction",
      "withdrawal",
      "removal",
      "historical-ownership"
    );
    const measured = devTasks.filter(({ id }) => partTasks.includes(id));
    expect({
      once: new Set(partTasks).size === partTasks.length,
      tasks: partTasks.toSorted(),
      // Withdrawal and removal in English, and again in Spanish and Dutch:
      // the parts check each answers from the corpus as it stands.
      current: current.filter((id) => partTasks.includes(id)).length,
      families: brainFamilies.filter(
        (family) => !measured.some((task) => task.family === family)
      ),
      languages: brainLanguages.filter(
        (language) => !measured.some((task) => task.language === language)
      ),
      // This file measures nothing itself: its run is the controls'.
      here: [coverage.families, coverage.languages],
      // Every admission case, in every language.
      unsupported: coverage.unsupported,
    }).toStrictEqual({
      once: true,
      tasks: devTasks.map(({ id }) => id).toSorted(),
      current: 7,
      families: [],
      languages: [],
      here: [{}, {}],
      unsupported: [{ requires: "interview-admission", probes: 55 }],
    });
  });

  it("measures every proposed budget in some part: what one part's tasks can't measure, another's do", () => {
    // Each part's file holds its arms to exactly these (`unmeasuredIn`).
    const unmeasured = brainBaselineParts.map((tasks) => unmeasuredIn(tasks));
    expect(
      brainProposedBudgets
        .map(({ name }) => name)
        .filter((name) => unmeasured.every((each) => each.includes(name)))
    ).toStrictEqual([]);
  });
});
