import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  baseline,
  build,
  removeScratch,
  scratch,
  versionIn,
} from "./build-harness.ts";

// Each build starts Node, TypeScript and three bundles.
describe("the compiler's build", { timeout: 120_000 }, () => {
  afterEach(removeScratch);

  it("builds the same release with a test or a declaration among the kit's sources", () => {
    // Built, if it isn't yet, before the files below are there.
    const version = versionIn(baseline().versionModule);
    const dir = scratch();
    const versionModule = path.join(dir, "version.js");
    // Next to the kit's components, as a test of one would be.
    // The build reads the kit where it is, so the files go there, for as
    // long as the build takes: removed whatever happens here, though a run
    // that is killed outright leaves them, untracked, to delete by hand.
    const added = ["probe.test.tsx", "probe.d.ts"].map((file) =>
      path.join(import.meta.dirname, "../ui/src/components", file)
    );
    try {
      for (const file of added) {
        writeFileSync(file, "export const probe = 1;\n");
      }
      build(path.join(dir, "assets"), versionModule, "production");
    } finally {
      for (const file of added) {
        rmSync(file, { force: true });
      }
    }

    expect(versionIn(versionModule)).toBe(version);
  });
});
