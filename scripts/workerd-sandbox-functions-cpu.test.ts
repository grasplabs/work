/**
 * An App's functions on the on-prem sandbox, on plain workerd: a stand-in
 * core (apps/core/test/workerd/functions-worker.ts) runs a release's
 * functions with the same runner core does, with `SANDBOX_HOST` bound to
 * the supervisor (workerd-sandbox.ts), so each call runs in a session.
 * Here, functions that spin until their CPU time is spent; the rest are
 * workerd-sandbox-functions.test.ts.
 */
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { nativeWorkerd, startSandboxSupervisor } from "./workerd-sandbox.ts";
import type { SandboxSupervisor } from "./workerd-sandbox.ts";
import { serveStandIn } from "./workerd-stand-in.ts";
import { cleanUp } from "./workerd-test-server.ts";

/** How long core may take to answer another request meanwhile. */
const ANSWER_MS = 500;

/**
 * A call's wall-clock cap: its deadline unless a test gives it another, a
 * server invocation's minute, as core gives it.
 */
const WALL_CAP_MS = platformLimits.serverInvocationWallMs;

/**
 * A call ended by its CPU time (`serverInvocationCpuMs`, 10 s) takes as
 * long in wall-clock time as its process needs to be given that much CPU:
 * about 10 s on an idle machine, over 15 s on a loaded CI runner sharing
 * its cores with the shard's other tests. So such a test says it ended
 * before its wall-clock cap, by its code (a call ended at its cap is
 * `function.deadline_exceeded`) and its time, and waits past that cap so
 * a call held to it fails on those, not on the test's own timeout.
 */
const CPU_TEST_TIMEOUT_MS = WALL_CAP_MS + 15_000;

const outcomeSchema = z.union([
  z.object({
    ok: z.literal(true),
    value: z.unknown(),
    ms: z.number(),
    logged: z.array(z.unknown()),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    }),
    ms: z.number(),
    logged: z.array(z.unknown()),
  }),
]);

/** What a failed call's caller gets, or `ok` for one that succeeded. */
const failure = (outcome: z.infer<typeof outcomeSchema>) =>
  outcome.ok ? { code: "ok", retryable: false } : outcome.error;

describe("an App's function on the on-prem sandbox", () => {
  let supervisor: SandboxSupervisor;
  let coreUrl: string;
  /** Processes the supervisor started: one more for each session it ran. */
  let processesStarted = 0;

  beforeAll(async () => {
    supervisor = await startSandboxSupervisor({
      workerd: nativeWorkerd,
      processes: 2,
      log: (event) => {
        if (event.event === "sandbox.process_started") {
          processesStarted += 1;
        }
      },
    });
    coreUrl = await serveStandIn("functions-worker.ts", supervisor.socket);
  }, 120_000);

  afterAll(async () => {
    await supervisor.stop();
    cleanUp();
  });

  const call = async (
    path: string,
    {
      within = WALL_CAP_MS,
      owner = "app-stand-in",
      endLost = false,
      slowNested = false,
      settle = 0,
    } = {}
  ) => {
    const response = await fetch(
      `${coreUrl}run?path=${path}&within=${within}&owner=${owner}&endLost=${endLost ? 1 : 0}&slowNested=${slowNested ? 1 : 0}&settle=${settle}`
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

  it(
    "ends the call as cpu_exceeded when a function it nests loops",
    async () => {
      const outcome = await call("callsBusy");
      expect(failure(outcome)).toMatchObject({ code: "function.cpu_exceeded" });
      expect(outcome.ms).toBeLessThan(WALL_CAP_MS);
    },
    CPU_TEST_TIMEOUT_MS
  );

  it(
    "ends a busy-looping function on its CPU-time budget while core keeps answering",
    async () => {
      const busy = call("busy");
      const answers: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one after another, during the loop
        answers.push(await answerTime());
      }
      const outcome = await busy;
      expect(failure(outcome)).toMatchObject({
        code: "function.cpu_exceeded",
        retryable: false,
      });
      // Its 10 s of CPU, as Cloudflare gives a function, and not a minute.
      expect(outcome.ms).toBeLessThan(WALL_CAP_MS);
      expect(Math.max(...answers)).toBeLessThan(ANSWER_MS);
    },
    CPU_TEST_TIMEOUT_MS
  );
});
