/**
 * Each App's part of the package builder's share of the on-prem sandbox, on plain workerd: a
 * stand-in core (apps/core/test/workerd/builds-worker.ts) runs the same
 * `runBuilder` a build runs, with `SANDBOX_HOST` bound to
 * the supervisor (workerd-sandbox.ts) and the builder core's build makes
 * (workerd-builder-stand-in.ts).
 * One App's builds hold part of the builders' share, so another App's
 * build still runs, and a build given up on never holds the next.
 */
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  callStandIn,
  serveBuilderStandIn,
} from "./workerd-builder-stand-in.ts";
import { nativeWorkerd, startSandboxSupervisor } from "./workerd-sandbox.ts";
import type { SandboxSupervisor } from "./workerd-sandbox.ts";
import { cleanUp } from "./workerd-test-server.ts";

describe("the package builder on the on-prem sandbox", () => {
  /** A pool of four, so the builder's share is two: one each for two Apps. */
  let wide: SandboxSupervisor;
  let wideUrl: string;
  /** A second core isolate on that pool, so one App's builds come from two isolates at once. */
  let otherUrl: string;

  beforeAll(async () => {
    wide = await startSandboxSupervisor({
      workerd: nativeWorkerd,
      processes: 4,
      log: () => {},
    });
    wideUrl = await serveBuilderStandIn(wide.socket);
    otherUrl = await serveBuilderStandIn(wide.socket);
  }, 120_000);

  afterAll(async () => {
    await wide.stop();
    cleanUp();
  });

  it("runs an App's next build once a build of its was given up on by its caller, never waiting on that one for good", async () => {
    const next = await callStandIn(
      "app=app-cancelled",
      "/cancelled-build",
      wideUrl
    );

    expect(next.status).toBe("ok");
  }, 60_000);

  it("holds one App's builds to part of the builders' share, so another App's build still runs", async () => {
    // The builders' share of four processes is two. One App's build holds
    // one; its build from another isolate of core waits for that one.
    const held = callStandIn("builder=busy&app=app-a", "/build", wideUrl);
    await expect
      .poll(() => wide.stats().subOwnerPlaces, { timeout: 5000, interval: 50 })
      .toBe(1);
    const waiting = callStandIn("builder=busy&app=app-a", "/build", otherUrl);
    await expect
      .poll(() => wide.stats().waitingForOwners, {
        timeout: 5000,
        interval: 50,
      })
      .toBe(1);
    // The other place is another App's, while the first App's builds hold
    // theirs and wait.
    const other = await callStandIn(
      "builder=busy&app=app-b",
      "/build",
      wideUrl
    );
    const [first, second] = await Promise.all([held, waiting]);

    expect({
      other: other.status,
      held: first.status,
      // It asked again until the App's place came free, then ran.
      waiting: second.status,
    }).toStrictEqual({ other: "bound", held: "bound", waiting: "bound" });
    // Every App's place given back once its process is gone.
    await expect
      .poll(() => wide.stats().subOwnerPlaces, { timeout: 5000, interval: 100 })
      .toBe(0);
  }, 60_000);
});
