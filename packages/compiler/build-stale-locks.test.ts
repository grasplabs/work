import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  build,
  heldLock,
  releaseFiles,
  removeScratch,
  scratch,
  wholeRelease,
} from "./build-harness.ts";
import { startOf } from "./build-lock.ts";

// Each build starts Node, TypeScript and three bundles.
describe("the compiler's build", { timeout: 120_000 }, () => {
  afterEach(removeScratch);

  it("words a process's start time the same in every time zone and language", () => {
    const { LC_ALL: language, TZ: zone } = process.env;
    const worded: string[] = [];
    try {
      for (const [timeZone, locale] of [
        ["Asia/Tokyo", "C"],
        ["America/New_York", "nl_NL.UTF-8"],
      ] as const) {
        process.env.TZ = timeZone;
        process.env.LC_ALL = locale;
        worded.push(startOf(process.pid));
      }
    } finally {
      for (const [name, value] of [
        ["TZ", zone],
        ["LC_ALL", language],
      ] as const) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, name);
        } else {
          process.env[name] = value;
        }
      }
    }
    expect(worded[0]).not.toBe("unknown");
    expect(worded[1]).toBe(worded[0]);
  });

  it("takes over the lock of a build that no longer runs", () => {
    const dir = scratch();
    const assets = path.join(dir, "assets");
    const versionModule = path.join(dir, "version.js");
    // A process that has ended: its ID is no running build's.
    const { pid: ended } = spawnSync(process.execPath, ["-e", ""]);
    heldLock(assets, ended, startOf(process.pid));

    build(assets, versionModule, "production");

    expect(wholeRelease(assets, versionModule)).toStrictEqual(releaseFiles);
    expect(readdirSync(dir).toSorted()).toStrictEqual(["assets", "version.js"]);
  });

  it("takes over the lock of a build whose process ID another process has now", () => {
    const dir = scratch();
    const assets = path.join(dir, "assets");
    const versionModule = path.join(dir, "version.js");
    // The owner's ID is this process's, which runs, but the owner started
    // at another time: it was another process, which is gone.
    heldLock(assets, process.pid, "Thu-Jan-1-00-00-00-1970");

    build(assets, versionModule, "production");

    expect(wholeRelease(assets, versionModule)).toStrictEqual(releaseFiles);
    expect(readdirSync(dir).toSorted()).toStrictEqual(["assets", "version.js"]);
  });
});
