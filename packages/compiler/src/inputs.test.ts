import { appLimits, appManifestMaxBytes } from "@grasp-os/shared/app-limits";
import { describe, expect, it } from "vite-plus/test";

import { appCodeLimitErrors } from "./inputs.ts";

// What a build of an App's server code takes, on its own: pure, so tested
// in isolation. The App's own files keep the App's limits; the modules
// the host generates (`.grasp/`) are held to a bound of their own: at
// most 8 of them, each at most 4 times the largest manifest the platform
// accepts, and 8 times it together.

const most = {
  files: 8,
  length: 4 * appManifestMaxBytes,
  total: 8 * appManifestMaxBytes,
};

/** The modules the host generates, `count` of them, each `length` long. */
const generated = (count: number, length: number): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: count }, (_unused, index) => [
      `.grasp/module-${index}.ts`,
      "x".repeat(length),
    ])
  );

/** Which files the diagnostics name, with no file as "build". */
const named = (files: Record<string, string>): string[] =>
  appCodeLimitErrors(files).map((diagnostic) => diagnostic.file ?? "build");

describe("the modules the host generates for a build", () => {
  it("are taken up to their own bound, on top of an App at its limits", () => {
    const own = Object.fromEntries(
      Array.from({ length: appLimits.files }, (_unused, index) => [
        `operations/file-${index}.ts`,
        "x".repeat(appLimits.totalLength / appLimits.files),
      ])
    );
    expect(named({ ...own, ...generated(2, most.length) })).toStrictEqual([]);
  });

  it("are refused past their count", () => {
    expect(named(generated(most.files + 1, 1))).toStrictEqual(["build"]);
  });

  it("are refused when one is past its length", () => {
    expect(
      named({
        ...generated(1, 1),
        ".grasp/large.ts": "x".repeat(most.length + 1),
      })
    ).toStrictEqual([".grasp/large.ts"]);
  });

  it("are refused when together they are past their total", () => {
    const each = Math.floor(most.total / 3) + 1;
    expect(each).toBeLessThanOrEqual(most.length);
    expect(named(generated(3, each))).toStrictEqual(["build"]);
  });

  it("never lend the App's own files room past the App's limits", () => {
    const own = Object.fromEntries(
      Array.from({ length: appLimits.files + 1 }, (_unused, index) => [
        `operations/file-${index}.ts`,
        "",
      ])
    );
    expect(named(own)).toStrictEqual(["build"]);
  });
});
