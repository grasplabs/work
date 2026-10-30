import type { ReleaseManifest } from "@grasp-os/shared/release";
import { describe, expect, it } from "vite-plus/test";

import { builds, info } from "../release/fixture-release.ts";
import { generateManifest } from "../release/manifest-lib.ts";
import { runCapacity, workloadPassed } from "./capacity-lib.ts";
import type { CapacityWorkload } from "./workloads.ts";

// The capacity job (GRA-942), from what a run must not prove first: a
// raise with no workload, or one whose workload doesn't run on the
// profile; a run on another commit; one workload failing among others.

const manifest: ReleaseManifest = generateManifest(info, await builds());
const steps = info.platformLimits.workflowSteps ?? 0;

/** The release before, with `workflowSteps` lower: one raise. */
const before = {
  releaseId: "25.12.1",
  platformLimits: { ...info.platformLimits, workflowSteps: steps - 1 },
};

const workerdOnly: CapacityWorkload = {
  test: "test/capacity/workflow-steps.capacity.test.ts",
  profiles: ["workerd"],
};

/** Runs the job with workloads that pass, recording what ran at which value. */
const job = async (
  options: {
    previous?: unknown;
    checkedOut?: string;
    workloads?: Record<string, CapacityWorkload>;
    passes?: boolean;
  } = {}
) => {
  const ran: string[] = [];
  const results = await runCapacity(
    manifest,
    "previous" in options ? options.previous : before,
    "workerd",
    options.checkedOut ?? manifest.commit,
    options.workloads ?? { workflowSteps: workerdOnly },
    async (workload, raise) => {
      ran.push(`${workload.test} at ${String(raise.raisedTo)}`);
      return await Promise.resolve(options.passes ?? true);
    }
  );
  return { ran, results };
};

/** What a job ending in a throw said, or "ok". */
const outcome = async (running: Promise<unknown>): Promise<string> => {
  try {
    await running;
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

describe("the capacity job", () => {
  it("runs each raised limit's workload at its raised value, on the release's own commit, and names what passed", async () => {
    await expect(job()).resolves.toStrictEqual({
      ran: [`${workerdOnly.test} at ${steps}`],
      results: [
        {
          limit: "workflowSteps",
          raisedTo: steps,
          profile: "workerd",
          commit: manifest.commit,
        },
      ],
    });
  });

  it("runs nothing, and asks nothing of the commit, for a release that raises no limit", async () => {
    await expect(
      job({ previous: null, checkedOut: "f".repeat(40), workloads: {} })
    ).resolves.toStrictEqual({ ran: [], results: [] });
  });

  it("refuses a run on another commit, a raise with no workload or none for the profile, and a failing workload, proving nothing", async () => {
    const refused = await Promise.all([
      outcome(job({ checkedOut: "f".repeat(40) })),
      outcome(job({ workloads: {} })),
      outcome(
        job({
          workloads: {
            workflowSteps: { ...workerdOnly, profiles: ["cloudflare"] },
          },
        })
      ),
      outcome(job({ passes: false })),
    ]);

    expect(refused.map((said) => said.split(":")[0])).toStrictEqual([
      `The capacity job runs on ${"f".repeat(40)}, not release ${manifest.releaseId}'s ${manifest.commit}`,
      "No capacity workload for workflowSteps on workerd",
      "No capacity workload for workflowSteps on workerd",
      `The capacity workload for workflowSteps failed at ${steps} on workerd`,
    ]);
  });
});

/**
 * The report Vitest writes (`--reporter=json`) for a run whose file filter
 * matches nothing, as a mistyped workload path does: no test ran, and the
 * run exits 0 and calls itself a success. Taken from such a run; spawning
 * one here would boot every project of the workspace for nothing.
 */
const ranNothing = {
  numTotalTestSuites: 0,
  numPassedTestSuites: 0,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  numTotalTests: 0,
  numPassedTests: 0,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  success: true,
  testResults: [],
};

describe("a capacity workload's run", () => {
  it("proves nothing for a mistyped path, which Vitest runs as nothing, exiting 0", () => {
    expect(workloadPassed(ranNothing)).toBeFalsy();
  });

  it("holds only when a test passed and none failed, skipped or was left to do", () => {
    const run = {
      success: true,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
    };
    expect({
      passed: workloadPassed(run),
      skipped: workloadPassed({ ...run, numPendingTests: 1 }),
      todo: workloadPassed({ ...run, numTodoTests: 1 }),
      failed: workloadPassed({ ...run, success: false, numFailedTests: 1 }),
      nothing: workloadPassed({ ...run, numPassedTests: 0 }),
      unreadable: workloadPassed("not a report"),
    }).toStrictEqual({
      passed: true,
      skipped: false,
      todo: false,
      failed: false,
      nothing: false,
      unreadable: false,
    });
  });
});
