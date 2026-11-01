/**
 * Bundles the connect Worker the way its deploy does, so core's tests call
 * the real one over the CONNECT service binding.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildConnectors,
  connectorEntries,
  connectorsFile,
} from "../../connect/build.ts";
import { testComposioClassesFile } from "../../connect/test/global-setup.ts";
import { testRun } from "./test-run.ts";

const connect = path.join(import.meta.dirname, "../../connect");
const wrangler = path.join(connect, "node_modules/wrangler/bin/wrangler.js");

/**
 * Where core's global setup writes the bundle for its tests: in the run's
 * own directory, so another run can't rewrite it while this one's config
 * reads it.
 */
export const connectBundle = path.join(testRun, "connect.js");

/** The connect Worker's bundle, as one ES module, its connectors in it. */
export const bundleConnect = async (): Promise<string> => {
  await buildConnectors(connectorEntries(), connectorsFile);
  const out = mkdtempSync(path.join(tmpdir(), "grasp-os-connect-"));
  try {
    // Its output is only shown if bundling fails, in the error. The fake
    // Composio's tools are classed as in connect's own tests.
    execFileSync(
      process.execPath,
      [
        wrangler,
        "deploy",
        "--dry-run",
        "--outdir",
        out,
        "--alias",
        `#composio-classes:${testComposioClassesFile}`,
      ],
      { cwd: connect }
    );
    const bundle = path.join(out, "index.js");
    // The launcher reports its CLI dying of a signal as success.
    if (!existsSync(bundle)) {
      throw new Error(
        "Wrangler exited without writing connect's bundle. Its launcher reports a CLI killed by a signal as success, so check for a crash."
      );
    }
    return readFileSync(bundle, "utf-8");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
};
