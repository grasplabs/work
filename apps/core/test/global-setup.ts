import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { writeAgentDocs } from "../build-agent-docs.ts";
import {
  blueprintsDir,
  testBlueprintsModule,
  writeBlueprints,
} from "../build-blueprints.ts";
import buildExtractor from "../build-extractor.ts";
import { bundleConnect, connectBundle } from "./build-connect.ts";
import { testVersionModule } from "./compiler-version.ts";
import { prebuiltKey, restorePrebuilt, savePrebuilt } from "./prebuilt.ts";
import { runNode } from "./run-node.ts";
import { removeEndedRuns, removeTestRun, testAssets } from "./test-run.ts";

/**
 * Builds the App compiler as core's build does, in a process of its
 * own: what the tests load and measure is then what a release ships, byte
 * for byte. Built in this process, Vite's own code would be the copy the
 * test runner transformed, and some of that ends up in the kit.
 */
const buildAppCompiler = async (): Promise<void> => {
  await runNode(
    [
      path.join(import.meta.dirname, "../../../packages/compiler/build.ts"),
      testAssets,
      testVersionModule,
    ],
    { output: "inherit" }
  );
};

const writeTestAssets = async (): Promise<void> => {
  rmSync(testAssets, { recursive: true, force: true });
  cpSync(path.join(import.meta.dirname, "fixtures/assets"), testAssets, {
    recursive: true,
  });
  // The compiler builds in a process of its own, so the extractor builds
  // here meanwhile.
  await Promise.all([buildAppCompiler(), buildExtractor(testAssets)]);
};

const writeConnectBundle = async (): Promise<void> => {
  mkdirSync(path.dirname(connectBundle), { recursive: true });
  writeFileSync(connectBundle, await bundleConnect());
};

const prepare = async (): Promise<void> => {
  removeEndedRuns();
  // The release's built-ins, and one of the tests' own, so the install
  // has a blueprint to write while the release ships none: into the
  // tests' module, never the one core's build ships.
  writeBlueprints(
    [blueprintsDir, path.join(import.meta.dirname, "fixtures/blueprints")],
    testBlueprintsModule
  );
  // The guides the agent reads, as core's build embeds them.
  writeAgentDocs();
  // The builds below, reused when their inputs are those of a build kept
  // earlier (prebuilt.ts).
  const files = {
    assets: testAssets,
    versionModule: testVersionModule,
    connectBundle,
  };
  const key = prebuiltKey();
  if (key !== null && restorePrebuilt(key, files)) {
    return;
  }
  // At once: the compiler's build and Wrangler's bundle of connect run in
  // processes of their own, and each took over 10 s of a CI runner's
  // start, one after the other.
  await Promise.all([writeTestAssets(), writeConnectBundle()]);
  if (key !== null) {
    savePrebuilt(key, files);
  }
};

declare global {
  // Both of core's projects run this setup, in one process: the work is
  // done once per run, by whichever comes first.
  var coreTestSetup: Promise<void> | undefined;
}

/**
 * Before any test of a project: embeds the built-in blueprints and the
 * docs' guides the agent reads (build-agent-docs.ts), writes
 * the test assets and bundles the connect Worker, which the project's config reads when its pool starts.
 * After the run, removes what it wrote for itself; Vitest tears down only
 * once every project's tests are done. A watch run whose config changed
 * tears down and sets up again in this process: forgetting the setup then
 * makes it build again, rather than find its directory gone.
 */
const setup = async (): Promise<() => void> => {
  globalThis.coreTestSetup ??= prepare();
  await globalThis.coreTestSetup;
  return () => {
    globalThis.coreTestSetup = undefined;
    removeTestRun();
  };
};

export default setup;
