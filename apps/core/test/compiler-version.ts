import path from "node:path";

import { testRun } from "./test-run.ts";

/**
 * The module core's tests import as the compiler's `#version`
 * (vite.config.ts): the version of the compiler the global setup builds
 * into the tests' assets. Core's build writes its own, for the assets it
 * ships; with one module for both, a test run after a change to the kit
 * would point a running dev server at a compiler its assets don't have.
 * One per run likewise, next to the run's assets: another run, built from
 * newer sources, would otherwise point this one at its compiler.
 */
export const testVersionModule = path.join(testRun, "compiler-version.js");
