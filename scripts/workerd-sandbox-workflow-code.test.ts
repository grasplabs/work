/**
 * A workflow's metadata, tests and dry runs on the on-prem sandbox, on
 * plain workerd: a stand-in core (apps/core/test/workerd/
 * workflow-code-worker.ts) makes the same call core makes of each
 * (workflows/code.ts), with `SANDBOX_HOST` bound to the supervisor
 * (workerd-sandbox.ts), so each runs in a session of its own.
 */
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { nativeWorkerd, startSandboxSupervisor } from "./workerd-sandbox.ts";
import type { SandboxSupervisor } from "./workerd-sandbox.ts";
import { serveStandIn } from "./workerd-stand-in.ts";
import { cleanUp, tempDir } from "./workerd-test-server.ts";

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

/** How workflow `notes`'s tests went with harness `name`, on core at `url`. */
const tests = async (name: string, url: string) => {
  const response = await fetch(`${url}tests?case=${name}`);
  return z
    .object({ failures: z.array(z.string()), keep: z.boolean() })
    .parse(await response.json());
};

describe("a workflow's code read on the on-prem sandbox", () => {
  let supervisor: SandboxSupervisor;
  let coreUrl: string;

  beforeAll(async () => {
    supervisor = await startSandboxSupervisor({
      workerd: nativeWorkerd,
      processes: 2,
      // No memory bound of its own: a test past V8's heap limit ends its
      // process itself.
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
    const state = { settled: false };
    const busy = run("busy").finally(() => {
      state.settled = true;
    });
    // Its session confirmed running before core is timed, and core timed
    // all the while it runs: each answer counts only if the loop still ran
    // when it came.
    await expect
      .poll(() => supervisor.stats().inFlight, {
        timeout: 10_000,
        interval: 20,
      })
      .toBe(1);
    const answers: number[] = [];
    while (!state.settled) {
      // oxlint-disable-next-line no-await-in-loop -- one after another, during the loop
      const ms = await answerTime();
      if (supervisor.stats().inFlight === 1) {
        answers.push(ms);
      }
      // oxlint-disable-next-line no-await-in-loop -- a sample every so often
      await sleep(200);
    }
    const outcome = await busy;
    expect(answers.length).toBeGreaterThanOrEqual(4);
    expect(outcome.ok).toBeFalsy();
    expect(outcome.ok ? null : outcome.codes).toContain("CPU time");
    // Its 30 s of CPU time, and not the call's five minutes.
    expect(outcome.ms).toBeLessThan(40_000);
    expect(answers.filter((ms) => ms >= ANSWER_MS)).toStrictEqual([]);
  }, 60_000);

  it("takes code that doesn't load as the code's failure", async () => {
    const outcome = await run("doesntLoad");
    expect(outcome.ok).toBeFalsy();
    expect(outcome.ok ? null : outcome.codes).not.toBeNull();
  });

  it("keeps what a workflow's tests say, even when they run past V8's heap: that is theirs", async () => {
    const [fails, exhausts] = [
      await tests("fails", coreUrl),
      await tests("exhausts", coreUrl),
    ];
    expect({
      fails,
      exhausts: { failed: exhausts.failures.length, keep: exhausts.keep },
    }).toStrictEqual({
      fails: { failures: ['notes, "t": no'], keep: true },
      exhausts: { failed: 1, keep: true },
    });
  }, 60_000);

  it("doesn't keep what a workflow's tests say when their process was killed from outside: that may be the sandbox's", async () => {
    // workerd behind a shell that SIGKILLs it four seconds in, as the
    // kernel's OOM killer kills a process of a full cgroup.
    const killed = path.join(tempDir(), "killed-from-outside.sh");
    writeFileSync(
      killed,
      `#!/bin/sh\n"${nativeWorkerd}" "$@" &\nchild=$!\nsleep 4\nkill -9 $child\nwait $child\nexit $?\n`
    );
    chmodSync(killed, 0o755);
    const killing = await startSandboxSupervisor({
      workerd: killed,
      processes: 2,
      log: () => {},
    });
    try {
      const url = await serveStandIn("workflow-code-worker.ts", killing.socket);
      const spins = await tests("spins", url);
      expect({ failed: spins.failures.length, keep: spins.keep }).toStrictEqual(
        { failed: 1, keep: false }
      );
    } finally {
      await killing.stop();
    }
  }, 60_000);
});
