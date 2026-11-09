/**
 * Builds an immutable release: core and connect bundled exactly as
 * `wrangler deploy` would upload them (a dry run into a directory), the
 * frontend's static files, every D1 migration, and the manifest that
 * describes it all. Nothing is uploaded or deployed.
 *
 * The output directory is laid out as the release is stored in R2
 * (upload-release.ts): `blobs/modules/<sha256>`, `blobs/migrations/<sha256>`,
 * `blobs/assets/<asset hash>`, then `manifest.json`, written last and
 * checked against every blob before the build succeeds. It also holds a
 * `.grasp-release` marker: an existing `--out` is replaced only when it's
 * empty or holds one.
 *
 * Usage: vp run release:build --out <dir> [--release-id <id>]
 */
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { parseJsonc } from "../wrangler-config-rules.ts";
import { collectAssets, collectModules, collectSqlFiles } from "./hash-lib.ts";
import type { CollectedFile } from "./hash-lib.ts";
import {
  assertReleaseDir,
  generateManifest,
  parseWranglerConfig,
  verifyRelease,
  writeRelease,
} from "./manifest-lib.ts";
import type { WorkerBuild } from "./manifest-lib.ts";

const ROOT = path.join(import.meta.dirname, "../..");

// The Workers a client account runs, in deploy order: core binds connect.
// The frontend ships as core's static assets.
const RELEASED_APPS = ["connect", "core"] as const;
const FRONTEND = "web";

const run = (command: string, args: string[], cwd = ROOT): string =>
  execFileSync(command, args, { cwd, encoding: "utf-8" }).trim();

/**
 * Runs a build beside others, printing its output whole once it ends, so
 * two builds' lines never interleave; a failed build prints what it wrote
 * before the error.
 */
const runBeside = async (
  command: string,
  args: string[],
  cwd = ROOT
): Promise<void> => {
  const label = `${path.relative(ROOT, cwd) || "."}$ ${command} ${args.join(" ")}`;
  const output: string[] = [];
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk: Buffer) => {
    output.push(chunk.toString());
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output.push(chunk.toString());
  });
  // Rejects with the spawn's error, if it couldn't start.
  await once(child, "close");
  console.info(`${label}\n${output.join("")}`);
  if (child.exitCode !== 0) {
    throw new Error(
      `${label} exited with ${String(child.exitCode ?? child.signalCode)}`
    );
  }
};

const { values: args } = parseArgs({
  options: {
    out: { type: "string" },
    "release-id": { type: "string" },
  },
});
if (args.out === undefined) {
  throw new Error("--out <dir> is required");
}
const out = path.resolve(args.out);

const commit = process.env.GITHUB_SHA ?? run("git", ["rev-parse", "HEAD"]);

// A build's id until it's published: a timestamp, so every build is a
// release of its own. CI's publish gives it its id (`YY.MM.N`) from the
// bucket it's published to (upload-release.ts --assign-id); only the
// manifest's id changes then, never a blob.
const defaultReleaseId = (): string =>
  `dev-${Math.floor(Date.now() / 1000).toString(36)}`;

const packageJson = z.object({
  version: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
});

const readPackageJson = (dir: string): z.infer<typeof packageJson> =>
  packageJson.parse(
    JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8"))
  );

// The installed version of every third-party runtime dependency the release
// is built from. Workspace packages have no version: the commit is theirs.
const packageVersions = (apps: readonly string[]): Record<string, string> => {
  const versions: Record<string, string> = {};
  for (const app of apps) {
    const dir = path.join(ROOT, "apps", app);
    for (const [name, spec] of Object.entries(
      readPackageJson(dir).dependencies ?? {}
    )) {
      if (spec.startsWith("workspace:")) {
        continue;
      }
      const { version } = readPackageJson(path.join(dir, "node_modules", name));
      if (version === undefined) {
        throw new Error(`${name} (a dependency of ${app}) has no version`);
      }
      versions[name] = version;
    }
  }
  return versions;
};

const buildWorker = async (
  app: string,
  bundleDir: string
): Promise<WorkerBuild> => {
  const dir = path.join(ROOT, "apps", app);
  const configFile = path.join(dir, "wrangler.jsonc");
  const config = parseWranglerConfig(
    path.relative(ROOT, configFile),
    parseJsonc(readFileSync(configFile, "utf-8"))
  );
  // Each app's own build step.
  await runBeside("vp", ["run", "build"], dir);
  const outDir = path.join(bundleDir, app);
  await runBeside("wrangler", ["deploy", "--dry-run", "--outdir", outDir], dir);
  return {
    key: app,
    config,
    ...(await collectModules(outDir, {
      sourceMaps: config.upload_source_maps,
    })),
    d1Migrations: Object.fromEntries(
      await Promise.all(
        config.d1_databases.map(
          async (database): Promise<[string, CollectedFile[]]> => [
            database.binding,
            await collectSqlFiles(path.join(dir, database.migrations_dir)),
          ]
        )
      )
    ),
    ...(config.assets
      ? {
          assets: await collectAssets(path.join(dir, config.assets.directory)),
        }
      : {}),
  };
};

const releaseId = args["release-id"] ?? defaultReleaseId();
const wranglerVersion = readPackageJson(
  path.join(ROOT, "node_modules/wrangler")
).version;
if (wranglerVersion === undefined) {
  throw new Error("wrangler has no version");
}
console.info(`Building release ${releaseId} from ${commit}`);
// Refuses a mistyped --out before minutes of building, not after. Only a
// check: an earlier release in it stays until this one is built.
assertReleaseDir(out);

// Collecting reads every bundle into memory, so the dry-run output can go.
// The Workers build at once, each on its own CPUs: one after another, with
// the frontend, they took 80 to 100 s of the release job (November 2026).
// Only core waits, for the frontend it serves: its build adds the compiled
// page runtime to the frontend's output.
const buildWorkers = async (): Promise<WorkerBuild[]> => {
  const bundleDir = mkdtempSync(path.join(tmpdir(), "grasp-os-release-"));
  try {
    return await Promise.all(
      RELEASED_APPS.map(async (app) => {
        if (app === "core") {
          await runBeside("vp", [
            "run",
            "--filter",
            `@grasp-os/${FRONTEND}`,
            "build",
          ]);
        }
        return await buildWorker(app, bundleDir);
      })
    );
  } finally {
    rmSync(bundleDir, { force: true, recursive: true });
  }
};
const workers = await buildWorkers();

const manifest = generateManifest(
  {
    releaseId,
    commit,
    createdAt: new Date().toISOString(),
    notes: run("git", ["log", "-1", "--format=%s", commit]),
    wranglerVersion,
    packages: packageVersions([...RELEASED_APPS, FRONTEND]),
  },
  workers
);
writeRelease(out, manifest, workers);
await verifyRelease(out);

const moduleCount = workers.reduce((n, w) => n + w.modules.length, 0);
console.info(
  `Release ${releaseId}: ${workers.length} Workers, ${moduleCount} modules, ${Object.keys(manifest.assets).length} assets, verified, in ${out}`
);
