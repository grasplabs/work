import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  build,
  earlierReleases,
  releasesIn,
  removeScratch,
  scratch,
  versionIn,
} from "./build-harness.ts";

// Each build starts Node, TypeScript and three bundles.
describe("the compiler's build", { timeout: 120_000 }, () => {
  afterEach(removeScratch);

  it("keeps the release a server started on through two more builds, and drops the one before", () => {
    const dir = scratch();
    const assets = path.join(dir, "assets");
    const versionModule = path.join(dir, "version.js");
    // A server started on `running` and hasn't reloaded; one build has
    // finished since (`second`), and `older` is from before the server.
    const [older, running, second] = [
      "0000000000000001",
      "0000000000000002",
      "0000000000000003",
    ];
    earlierReleases(assets, [older, running, second], -3_600_000);

    // The next build finishes before the server reloads, too.
    build(assets, versionModule, "production");

    expect(releasesIn(assets)).toStrictEqual(
      [running, second, versionIn(versionModule)].toSorted()
    );
  });
});
