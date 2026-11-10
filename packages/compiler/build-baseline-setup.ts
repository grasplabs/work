/**
 * Before the build's tests: a directory for the one release of these
 * sources that the tests share (`baseline` in build-harness.ts), built
 * by whichever test needs it first. A build takes half a minute of CPU,
 * and most tests need one only to read it or to build again on top of a
 * copy of it: built once per run instead of once per test, the files
 * shard on their own builds alone. Removed after the run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { baselineVariable } from "./build-harness.ts";

const setup = (): (() => void) => {
  const dir = mkdtempSync(path.join(tmpdir(), "grasp-compiler-baseline-"));
  // Workers start after the setup, with its environment.
  process.env[baselineVariable] = dir;
  return () => {
    rmSync(dir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, baselineVariable);
  };
};

export default setup;
