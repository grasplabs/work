/**
 * An App's functions on the on-prem sandbox, on plain workerd: a stand-in
 * core (apps/core/test/workerd/functions-worker.ts) runs a release's
 * functions with the same runner core does, with `SANDBOX_HOST` bound to
 * the supervisor (workerd-sandbox.ts), so each call runs in a session.
 */
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { nativeWorkerd, startSandboxSupervisor } from "./workerd-sandbox.ts";
import type { SandboxSupervisor } from "./workerd-sandbox.ts";
import { serveStandIn } from "./workerd-stand-in.ts";
import { cleanUp } from "./workerd-test-server.ts";

/** How long core may take to answer another request meanwhile. */
const ANSWER_MS = 500;

const outcomeSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown(), ms: z.number() }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    }),
    ms: z.number(),
  }),
]);

/** What a failed call's caller gets, or `ok` for one that succeeded. */
const failure = (outcome: z.infer<typeof outcomeSchema>) =>
  outcome.ok ? { code: "ok", retryable: false } : outcome.error;

describe("an App's function on the on-prem sandbox", () => {
  let supervisor: SandboxSupervisor;
  let coreUrl: string;

  beforeAll(async () => {
    supervisor = await startSandboxSupervisor({
      workerd: nativeWorkerd,
      processes: 2,
      log: () => {},
    });
    coreUrl = await serveStandIn("functions-worker.ts", supervisor.socket);
  }, 120_000);

  afterAll(async () => {
    await supervisor.stop();
    cleanUp();
  });

  const call = async (
    path: string,
    { within = 60_000, owner = "app-stand-in", endLost = false } = {}
  ) => {
    const response = await fetch(
      `${coreUrl}run?path=${path}&within=${within}&owner=${owner}&endLost=${endLost ? 1 : 0}`
    );
    return outcomeSchema.parse(await response.json());
  };

  /** How long core takes to answer a request that runs no App code. */
  const answerTime = async (): Promise<number> => {
    const started = Date.now();
    const response = await fetch(coreUrl, {
      signal: AbortSignal.timeout(2000),
    });
    await response.text();
    return Date.now() - started;
  };

  it("runs a function through the operation host", async () => {
    const outcome = await call("echo");
    expect(outcome).toMatchObject({ ok: true, value: { n: 1 } });
    await expect
      .poll(() => supervisor.stats(), { timeout: 3000 })
      .toMatchObject({ inFlight: 0 });
  });

  it.each([false, true])(
    "frees a finished function's process at once, even when core's word that it's over is lost (lost: %s)",
    async (endLost) => {
      const outcome = await call("echo", { endLost });
      expect(outcome.ok).toBeTruthy();
      // Well before its minute of wall-clock time.
      await expect
        .poll(() => supervisor.stats().inFlight, {
          timeout: 1500,
          interval: 50,
        })
        .toBe(0);
    }
  );

  it("runs functions nested three deep in the session of the one called, whatever the owner's share", async () => {
    // One process an owner here: each nested call taking one of its own
    // would wait for the place its callers hold.
    const outcome = await call("chain");
    expect(outcome).toMatchObject({ ok: true, value: { n: 4 } });
    expect(outcome.ms).toBeLessThan(3000);
    await expect
      .poll(() => supervisor.stats().inFlight, { timeout: 1500, interval: 50 })
      .toBe(0);
  });

  it("runs two such calls of one owner, one after the other within its share", async () => {
    const outcomes = await Promise.all([call("chain"), call("chain")]);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ ok: true, value: { n: 4 } });
    }
  });

  it("ends a busy-looping function on its CPU-time budget while core keeps answering", async () => {
    const busy = call("busy");
    const answers: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another, during the loop
      answers.push(await answerTime());
    }
    const outcome = await busy;
    expect(failure(outcome)).toMatchObject({
      code: "operation.cpu_exceeded",
      retryable: false,
    });
    // Its 10 s of CPU, as Cloudflare gives a function, and not a minute.
    expect(outcome.ms).toBeLessThan(15_000);
    expect(Math.max(...answers)).toBeLessThan(ANSWER_MS);
  }, 30_000);

  it("ends a function past its memory as the App's fault", async () => {
    const outcome = await call("hogs");
    expect(failure(outcome)).toMatchObject({
      code: "operation.memory_exceeded",
      retryable: false,
    });
  }, 30_000);

  it("refuses a function that sends core more than a call takes, as the App's fault", async () => {
    const outcome = await call("sendsTooMuch");
    expect(failure(outcome)).toMatchObject({
      code: "operation.sandbox_refused",
      retryable: false,
    });
  }, 30_000);

  it("keeps an error the App's code threw its own, whatever it says of itself", async () => {
    const outcome = await call("forgesVerdict");
    expect(failure(outcome).code).toBe("internal.unexpected");
  });

  it("frees a function's process once the host stops waiting for it", async () => {
    const outcome = await call("waits", { within: 300 });
    expect(failure(outcome).code).toBe("operation.deadline_exceeded");
    expect(outcome.ms).toBeLessThan(3000);
    await expect
      .poll(() => supervisor.stats().inFlight, { timeout: 3000 })
      .toBe(0);
  });

  it("fails a call past its App's share of the sandbox as busy, to try again", async () => {
    const holding = call("waits", { within: 8000, owner: "app-busy" });
    await expect
      .poll(() => supervisor.stats().inFlight, { timeout: 3000 })
      .toBe(1);
    const outcome = await call("echo", { owner: "app-busy" });
    expect(failure(outcome)).toMatchObject({
      code: "operation.sandbox_busy",
      retryable: true,
    });
    await holding;
  }, 30_000);

  it("fails a call as the sandbox unavailable, to try again, when the supervisor is gone", async () => {
    await supervisor.stop();
    const outcome = await call("echo");
    expect(failure(outcome)).toMatchObject({
      code: "operation.sandbox_unavailable",
      retryable: true,
    });
  });
});
