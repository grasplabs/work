/**
 * Deploys one Worker of a built release (build-release.ts) with Wrangler,
 * from the release's own bytes: what CI deploys to grasp-os-staging, so
 * staging runs exactly the release that is then published for the
 * console (upload-release.ts), not a second build of the same commit.
 *
 * In order, each refusing the deploy when it fails:
 * 1. every file of the release is checked against its manifest
 *    (`verifyRelease`), and the Worker is laid out from the bytes that
 *    were checked (deploy-lib.ts);
 * 2. Wrangler's dry run of that layout must upload exactly the
 *    manifest's modules: the same names, types and SHA-256;
 * 3. the Worker's D1 migrations, from the release, are applied: they are
 *    additive, so the running version keeps working until this deploy
 *    replaces it;
 * 4. the Worker is deployed, and the id of the version it now runs is
 *    printed and, in a GitHub Actions step, set as its `version` output
 *    (accept-release.ts checks core answers as it).
 *
 * With --dry-run it stops after step 2: no credentials, no network.
 * Each `--var NAME:value` is passed on to `wrangler deploy`, as core's
 * deploy script passes its own.
 *
 * Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (not for --dry-run)
 * Usage: vp run release:deploy --release <dir> --worker <app> [--var NAME:value]... [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { assertUploadMatches, layOutWorker } from "./deploy-lib.ts";
import { collectModules } from "./hash-lib.ts";

const { values: args } = parseArgs({
  options: {
    release: { type: "string" },
    worker: { type: "string" },
    var: { type: "string", multiple: true, default: [] },
    "dry-run": { type: "boolean", default: false },
  },
});
if (args.release === undefined || args.worker === undefined) {
  throw new Error("--release <dir> and --worker <app> are required");
}
const releaseDir = path.resolve(args.release);
const app = args.worker;

const wrangler = (wranglerArgs: string[], env = process.env): void => {
  execFileSync("wrangler", wranglerArgs, { stdio: "inherit", env });
};

/** What `wrangler deploy` writes to its output file for a deploy. */
const deployOutput = z.looseObject({
  type: z.literal("deploy"),
  version_id: z.string().min(1),
});

/** The version `wrangler deploy` reported in `outputFile`. */
const deployedVersion = (outputFile: string): string => {
  const versions = readFileSync(outputFile, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      const entry = deployOutput.safeParse(JSON.parse(line));
      return entry.success ? [entry.data.version_id] : [];
    });
  const [version] = versions;
  if (version === undefined || versions.length > 1) {
    throw new Error(
      `wrangler deploy reported ${versions.length} versions, expected one`
    );
  }
  return version;
};

const workDir = mkdtempSync(path.join(tmpdir(), "grasp-os-deploy-"));
try {
  const { manifest, worker, config } = await layOutWorker(
    releaseDir,
    app,
    path.join(workDir, "worker")
  );
  console.info(
    `Release ${manifest.releaseId}: ${worker.name} verified against its manifest`
  );

  const dryRunDir = path.join(workDir, "dry-run");
  wrangler(["deploy", "--dry-run", "--outdir", dryRunDir, "--config", config]);
  assertUploadMatches(worker, await collectModules(dryRunDir));
  console.info(
    `Wrangler uploads ${worker.name}'s ${worker.modules.length} modules as the release has them`
  );

  if (args["dry-run"]) {
    console.info(`Dry run: ${worker.name} not deployed`);
  } else {
    for (const database of worker.d1Databases) {
      wrangler([
        "d1",
        "migrations",
        "apply",
        database.binding,
        "--remote",
        "--config",
        config,
      ]);
    }
    const outputFile = path.join(workDir, "wrangler-output.ndjson");
    const vars = args.var.flatMap((entry) => ["--var", entry]);
    wrangler(["deploy", "--config", config, ...vars], {
      ...process.env,
      WRANGLER_OUTPUT_FILE_PATH: outputFile,
    });
    const version = deployedVersion(outputFile);
    console.info(
      `${worker.name} runs version ${version} of release ${manifest.releaseId}`
    );
    const githubOutput = process.env.GITHUB_OUTPUT;
    if (githubOutput !== undefined && githubOutput !== "") {
      appendFileSync(githubOutput, `version=${version}\n`);
    }
  }
} finally {
  rmSync(workDir, { force: true, recursive: true });
}
