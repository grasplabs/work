/**
 * A workflow's metadata, tests and dry runs on the on-prem sandbox, on
 * plain workerd: a stand-in core (apps/core/test/workerd/
 * workflow-code-worker.ts) makes the same call core makes of each
 * (workflows/code.ts), with `SANDBOX_HOST` bound to the supervisor
 * (workerd-sandbox.ts), so each runs in a session of its own.
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
    codes: z.string().nullable(),
    message: z.string(),
    ms: z.number(),
  }),
]);

describe("a workflow's code read on the on-prem sandbox", () => {
  let supervisor: SandboxSupervisor;
  let coreUrl: string;

  beforeAll(async () => {
    supervisor = await startSandboxSupervisor({
      workerd: nativeWorkerd,
      processes: 2,
      // No memory bound of its own: a test past V8's heap limit crashes.
      memoryLimitBytes: 64 * 1024 ** 3,
      log: () => {},
    });
    coreUrl = await serveStandIn("workflow-code-worker.ts", supervisor.socket);
  }, 120_000);

  afterAll(async () => {
    await supervisor.stop();
    cleanUp();
  });

  const run = async (name: string) => {
    const response = await fetch(`${coreUrl}run?case=${name}`);
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

  it("reads it in a session, with AsyncLocalStorage as a workflow's isolate has it", async () => {
    const outcome = await run("reads");
    expect(outcome).toMatchObject({
      ok: true,
      value: { ok: true, value: { stored: 7 } },
    });
  });

  it("ends a busy loop on the workflow's CPU time as the code's failure, while core keeps answering", async () => {
    const busy = run("busy");
    const answers: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another, during the loop
      answers.push(await answerTime());
    }
    const outcome = await busy;
    expect(outcome.ok).toBeFalsy();
    expect(outcome.ok ? null : outcome.codes).toContain("CPU time");
    // Its 30 s of CPU time, and not the call's five minutes.
    expect(outcome.ms).toBeLessThan(40_000);
    expect(Math.max(...answers)).toBeLessThan(ANSWER_MS);
  }, 60_000);

  it("takes code that doesn't load as the code's failure", async () => {
    const outcome = await run("doesntLoad");
    expect(outcome.ok).toBeFalsy();
    expect(outcome.ok ? null : outcome.codes).not.toBeNull();
  });

  it("keeps what a workflow's tests say, but not when their isolate crashed: that may be the sandbox's", async () => {
    const tests = async (name: string) => {
      const response = await fetch(`${coreUrl}tests?case=${name}`);
      return z
        .object({ failures: z.array(z.string()), keep: z.boolean() })
        .parse(await response.json());
    };
    const [fails, crashes] = [await tests("fails"), await tests("crashes")];
    expect({
      fails,
      crashes: { failed: crashes.failures.length, keep: crashes.keep },
    }).toStrictEqual({
      fails: { failures: ['notes, "t": no'], keep: true },
      crashes: { failed: 1, keep: false },
    });
  }, 60_000);
});
