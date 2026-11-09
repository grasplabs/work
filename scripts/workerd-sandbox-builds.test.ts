/**
 * The package builder on the on-prem sandbox, on plain workerd: a
 * stand-in core (apps/core/test/workerd/builds-worker.ts) runs the same
 * `runBuilder` a build runs, with `SANDBOX_HOST` bound to
 * the supervisor (workerd-sandbox.ts) and the builder core's build makes
 * (workerd-builder-stand-in.ts).
 * Plain workerd ignores an isolate's CPU limit, so a package that holds
 * or exhausts the builder must never run in core's own process. (The
 * page compiler's own on-prem tests are core's test/on-prem/builds.test.ts.)
 * How builds share the pool is workerd-sandbox-builds-share.test.ts and
 * workerd-sandbox-builds-apps.test.ts.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  ANSWER_MS,
  DEADLINE_MS,
  builtModulesSchema,
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

  /** How long core takes to answer a request that builds nothing. */
  const answerTime = async (): Promise<number> => {
    const started = Date.now();
    const response = await fetch(coreUrl, {
      signal: AbortSignal.timeout(2000),
    });
    await response.text();
    return Date.now() - started;
  };

  it("builds a package on the sandbox host, not in core", async () => {
    const outcome = await call("package=plain");

    expect({
      status: outcome.status,
      built: builtModulesSchema.parse(outcome.value).map(({ entry }) => entry),
    }).toStrictEqual({ status: "ok", built: ["plain-package"] });
  }, 60_000);

  it("reads a tarball larger than one message to the sandbox carries, whole and in order", async () => {
    const outcome = await call("package=large");

    expect({
      status: outcome.status,
      built: builtModulesSchema.parse(outcome.value).length,
    }).toStrictEqual({ status: "ok", built: 1 });
  }, 60_000);

  it("refuses a decompression bomb with a reason, unpacking only up to its limit", async () => {
    const outcome = await call("package=bomb");

    expect(outcome).toMatchObject({
      status: "ok",
      value: {
        ok: false,
        refusals: [expect.stringContaining("unpack to more than")],
      },
    });
  }, 60_000);

  it("refuses a second read of a tarball's start, so the builder reads each chunk once", async () => {
    const outcome = await call("builder=reread");

    expect(outcome.value).toStrictEqual({ ok: false, refusals: ["refused"] });
  }, 60_000);

  it("lets the builder read a tarball of several chunks only on, from where it left off", async () => {
    const outcome = await call("builder=rereadLater&package=large");

    expect(outcome.value).toStrictEqual({
      ok: false,
      refusals: ["read refused refused"],
    });
  }, 60_000);

  it("reads the builder's code from core's assets once, however many calls it makes", async () => {
    const outcome = await call("package=plain", "/build-twice");

    expect({ status: outcome.status, read: outcome.value }).toStrictEqual({
      status: "ok",
      read: 1,
    });
  }, 60_000);

  it("reads the builder's code again once the request reading it was cancelled, rather than wait on that read for good", async () => {
    // workerd cancels a cancelled request's read, which then never ends:
    // the next request takes it for abandoned once a read may take no
    // longer (10 s), and reads the code itself.
    const outcome = await call("", "/cancelled-code");

    expect(outcome.status).toBe("ok");
    expect(outcome.value).toBe(2);
    expect(outcome.ms).toBeLessThan(15_000);
  }, 60_000);

  it("builds an approved lock on the sandbox host and puts back each module it wrote, whole and in order", async () => {
    const outcome = await call("package=built");

    expect(outcome).toMatchObject({ status: "ok" });

    const [built] = builtModulesSchema.parse(outcome.value);

    expect({
      holdsExport: built?.holdsExport,
      // The module took more than one chunk to write back.
      pastOneChunk: (built?.bytes ?? 0) > 1024 * 1024,
    }).toStrictEqual({ holdsExport: true, pastOneChunk: true });
  }, 60_000);

  it("takes no more of the modules written back than they may be", async () => {
    const outcome = await call("builder=overwrite");

    expect(outcome.value).toStrictEqual({
      ok: false,
      refusals: [`written ${8 * 1024 * 1024}`],
    });
  }, 60_000);

  it("ends a builder a package keeps busy for good at its deadline, and core answers meanwhile", async () => {
    const running = call("builder=busy");
    // Asked while the builder spins on the sandbox host.
    await sleep(1000);
    const meanwhile = await answerTime();
    const outcome = await running;

    expect(meanwhile).toBeLessThan(ANSWER_MS);
    expect(outcome.status).toBe("bound");
    // At its deadline, not at the 60 s a builder's call may take otherwise.
    expect(outcome.ms).toBeLessThan(DEADLINE_MS + 5000);
    await expect
      .poll(() => supervisor.stats().inFlight, { timeout: 5000, interval: 50 })
      .toBe(0);
  }, 60_000);

  it("ends a builder a package fills with memory, before its deadline", async () => {
    const before = supervisor.stats();
    const outcome = await call("builder=memory");
    const after = supervisor.stats();

    expect(outcome.status).toBe("bound");
    // Ended for its memory (or by V8 at its heap limit, as a crash).
    expect(
      after.memory - before.memory + (after.crashed - before.crashed)
    ).toBe(1);
  }, 60_000);
});
