/**
 * The capacity job (capacity-lib.ts): runs, on one runtime profile, the
 * workload of each platform limit a release raises over the release
 * published before it, on the release's own commit, and writes a result
 * for each that passed, for release:evidence's `--capacity`. Writes `[]`,
 * running nothing, when it raises none. Fails at the first workload that
 * fails, or a raise with no workload.
 *
 * Env: GITHUB_SHA, the commit checked out
 * Usage: vp run capacity --profile workerd --release <dir>
 *        --previous <file> --out <file>
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { runtimeProfileSchema } from "@grasp-os/shared/release";

import { verifyRelease } from "../release/manifest-lib.ts";
import { runCapacity, workloadPassed } from "./capacity-lib.ts";
import { capacityWorkloads } from "./workloads.ts";

const { values: args } = parseArgs({
  options: {
    profile: { type: "string" },
    release: { type: "string" },
    previous: { type: "string" },
    out: { type: "string" },
  },
});
if (
  args.release === undefined ||
  args.previous === undefined ||
  args.out === undefined
) {
  throw new Error("--release, --previous and --out are required");
}
const profile = runtimeProfileSchema.parse(args.profile);
if (profile !== "workerd") {
  // The cloudflare profile needs a real account in CI (GRA-382).
  throw new Error(`No capacity job runs on ${profile} yet`);
}
const core = path.join(import.meta.dirname, "../../apps/core");

const { manifest } = await verifyRelease(path.resolve(args.release));
const results = await runCapacity(
  manifest,
  JSON.parse(readFileSync(path.resolve(args.previous), "utf-8")),
  profile,
  process.env.GITHUB_SHA,
  capacityWorkloads,
  async (workload, raise) => {
    const report = path.join(
      mkdtempSync(path.join(tmpdir(), "grasp-os-capacity-")),
      "report.json"
    );
    try {
      execFileSync(
        "vp",
        [
          "test",
          "run",
          "-c",
          "vite.on-prem.config.ts",
          "--maxWorkers=1",
          "--reporter=json",
          `--outputFile=${report}`,
          workload.test,
        ],
        {
          cwd: core,
          stdio: "inherit",
          env: {
            ...process.env,
            CAPACITY_RAISED_TO: String(raise.raisedTo ?? "unbounded"),
          },
        }
      );
    } catch {
      return false;
    }
    // Ran, and ran something: a test passed, none skipped (capacity-lib.ts).
    return await Promise.resolve(
      existsSync(report) &&
        workloadPassed(JSON.parse(readFileSync(report, "utf-8")))
    );
  }
);
writeFileSync(path.resolve(args.out), `${JSON.stringify(results, null, 2)}\n`);
console.info(
  results.length === 0
    ? `Release ${manifest.releaseId} raises no platform limit: nothing to run`
    : `Release ${manifest.releaseId}: ${results.map(({ limit }) => limit).join(", ")} held on ${profile}`
);
