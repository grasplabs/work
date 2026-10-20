import { describe, expect, it } from "vite-plus/test";

import { packageLimitsOf } from "../src/packages.ts";

// The dependency limits a deployment runs with (`PACKAGE_LIMITS`): spec
// 18.1's figures as this release's ceilings, each lowerable by an
// operator, never raised, and each counted in its own unit.

const mib = 1024 * 1024;

describe("a deployment's dependency limits", () => {
  it("are spec 18.1's figures, or the package builder's capacity where that is lower", () => {
    const limits = packageLimitsOf({});
    expect({
      graphPackages: limits.graphPackages,
      graphDepth: limits.graphDepth,
      archiveBytes: limits.archiveBytes,
      extractedBytes: limits.extractedBytes,
      graphExtractedBytes: limits.graphExtractedBytes,
      artifactBytes: limits.artifactBytes,
    }).toStrictEqual({
      graphPackages: 500,
      graphDepth: 32,
      archiveBytes: 16 * mib,
      // Below the spec's 64 MiB and 128 MiB, and its 32 MiB artifact: what
      // the builder's isolate holds at once (packages.ts).
      extractedBytes: 40 * mib,
      graphExtractedBytes: 40 * mib,
      artifactBytes: 16 * mib,
    });
  });

  it("take an operator's lower figure, at or under the ceiling, and ignore a higher one", () => {
    const at = packageLimitsOf({
      graphPackages: 500,
      graphDepth: 32,
      archiveBytes: 16 * mib,
    });
    const lower = packageLimitsOf({
      graphPackages: 499,
      graphDepth: 31,
      archiveBytes: 16 * mib - 1,
    });
    const higher = packageLimitsOf({
      graphPackages: 501,
      graphDepth: 33,
      archiveBytes: 16 * mib + 1,
      extractedBytes: 64 * mib,
    });
    expect({
      at: [at.graphPackages, at.graphDepth, at.archiveBytes],
      lower: [lower.graphPackages, lower.graphDepth, lower.archiveBytes],
      higher: [
        higher.graphPackages,
        higher.graphDepth,
        higher.archiveBytes,
        higher.extractedBytes,
      ],
    }).toStrictEqual({
      at: [500, 32, 16 * mib],
      lower: [499, 31, 16 * mib - 1],
      higher: [500, 32, 16 * mib, 40 * mib],
    });
  });
});
