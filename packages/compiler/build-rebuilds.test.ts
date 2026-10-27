import { readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { build, removeScratch, scratch, versionIn } from "./build-harness.ts";
import { compilerAssets } from "./src/kit.ts";

// Each build starts Node, TypeScript and three bundles.
describe("the compiler's build", { timeout: 120_000 }, () => {
  afterEach(removeScratch);

  it("leaves a release that is there as it is when the same sources build again", () => {
    const dir = scratch();
    const assets = path.join(dir, "assets");
    const versionModule = path.join(dir, "version.js");
    build(assets, versionModule, "production");
    const version = versionIn(versionModule);
    const release = path.join(assets, compilerAssets.directory(version));
    const identityOf = (): Record<string, number[]> =>
      Object.fromEntries(
        readdirSync(release).map((file) => {
          const { ino, mtimeMs } = statSync(path.join(release, file));
          return [file, [ino, mtimeMs]];
        })
      );
    /** The file itself and when it was last written. */
    const moduleIdentity = (): number[] => {
      const { ino, mtimeMs } = statSync(versionModule);
      return [ino, mtimeMs];
    };
    const before = { release: identityOf(), module: moduleIdentity() };

    // A server reads these files while the watcher builds: under another
    // NODE_ENV too, they are never taken away or written again. Nor is
    // the version module, which the server would reload on.
    build(assets, versionModule, "development");

    expect(versionIn(versionModule)).toBe(version);
    expect({ release: identityOf(), module: moduleIdentity() }).toStrictEqual(
      before
    );
    expect(readdirSync(assets)).toStrictEqual(["_compiler"]);
  });

  it("builds the same release with a test or a declaration among the kit's sources", () => {
    const dir = scratch();
    const versionModule = path.join(dir, "version.js");
    build(path.join(dir, "assets"), versionModule, "production");
    const version = versionIn(versionModule);
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
