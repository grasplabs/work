import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  build,
  copyOfBaseline,
  removeScratch,
  versionIn,
} from "./build-harness.ts";
import { compilerAssets } from "./src/kit.ts";

// Each build starts Node, TypeScript and three bundles.
describe("the compiler's build", { timeout: 120_000 }, () => {
  afterEach(removeScratch);

  it("leaves a release that is there as it is when the same sources build again", () => {
    // As a production build of these sources left them.
    const { assets, versionModule } = copyOfBaseline();
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
});
