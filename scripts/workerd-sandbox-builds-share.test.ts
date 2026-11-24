/**
 * The package builder's share of the on-prem sandbox's pool, on plain workerd: a
 * stand-in core (apps/core/test/workerd/builds-worker.ts) runs the same
 * `runBuilder` a build runs, with `SANDBOX_HOST` bound to
 * the supervisor (workerd-sandbox.ts) and the builder core's build makes
 * (workerd-builder-stand-in.ts).
 * Builds hold their owner's share of the pool and no more, and App code
 * runs beside them.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  DEADLINE_MS,
  callStandIn,
  serveBuilderStandIn,
} from "./workerd-builder-stand-in.ts";
import { nativeWorkerd, startSandboxSupervisor } from "./workerd-sandbox.ts";
import type { SandboxSupervisor } from "./workerd-sandbox.ts";
import { cleanUp } from "./workerd-test-server.ts";

describe("the package builder on the on-prem sandbox", () => {
  let supervisor: SandboxSupervisor;
  let coreUrl: string;

  beforeAll(async () => {
    supervisor = await startSandboxSupervisor({
      workerd: nativeWorkerd,
      processes: 2,
      log: () => {},
    });
    coreUrl = await serveBuilderStandIn(supervisor.socket);
  }, 120_000);

  afterAll(async () => {
    await supervisor.stop();
    cleanUp();
  });

  const call = async (query: string, route = "/build") =>
    await callStandIn(query, route, coreUrl);

  it("keeps running App code while builds hold the builders' share of the pool", async () => {
    // One build holds its owner's share, and another waits for it: an App's
    // call takes the pool's other process meanwhile, at once.
    const first = call("builder=busy");
    await sleep(500);
    const second = call("builder=busy");
    await sleep(200);
    const app = await call("", "/app");
    await Promise.all([first, second]);

    expect({ status: app.status, value: app.value }).toStrictEqual({
      status: "ok",
      value: 42,
    });
    expect(app.ms).toBeLessThan(2000);
  }, 60_000);

  it("holds builds to one owner's share of the pool: past it, a build waits for a place, then runs, never the package's fault", async () => {
    // Two processes, so the builders hold one: the second build, another
    // App's in another isolate of core, asks again until the first's place
    // comes free, then runs to its own deadline.
    const first = call("builder=busy&app=app-first");
    await sleep(500);
    const second = await call("builder=busy&app=app-second");

    expect({
      second: second.status,
      waitedForTheFirst: second.ms > DEADLINE_MS,
    }).toStrictEqual({ second: "bound", waitedForTheFirst: true });
    await expect(first).resolves.toMatchObject({ status: "bound" });
  }, 60_000);
});
