/**
 * Code Mode on the on-prem sandbox, on plain workerd: a stand-in core
 * (apps/core/test/workerd/code-mode-session-worker.ts) runs the agent's
 * code with the same `runCode` core does, with `SANDBOX_HOST` bound to the
 * supervisor (workerd-sandbox.ts), so each run is a sandbox session.
 */
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { nativeWorkerd, startSandboxSupervisor } from "./workerd-sandbox.ts";
import type { SandboxSupervisor } from "./workerd-sandbox.ts";
import { serveStandIn } from "./workerd-stand-in.ts";
import { cleanUp } from "./workerd-test-server.ts";

/** How long core may take to answer another request meanwhile. */
const ANSWER_MS = 500;

const runSchema = z.object({
  status: z.string(),
  text: z.string(),
  ms: z.number(),
  streamed: z.array(z.string()),
  calls: z.number(),
  runtime: z.object({ runtime: z.string(), cpuLimit: z.string() }),
});

describe("a Code Mode run on the on-prem sandbox", () => {
  let supervisor: SandboxSupervisor;
  let coreUrl: string;

  beforeAll(async () => {
    supervisor = await startSandboxSupervisor({
      workerd: nativeWorkerd,
      processes: 2,
      log: () => {},
    });
    coreUrl = await serveStandIn(
      "code-mode-session-worker.ts",
      supervisor.socket
    );
  }, 120_000);

  afterAll(async () => {
    await supervisor.stop();
    cleanUp();
  });

  const run = async (name: string) => {
    const response = await fetch(`${coreUrl}run?case=${name}`);
    return runSchema.parse(await response.json());
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

  it("runs the code with the chat's APIs, streaming what it logs, and records the CPU limit as enforced", async () => {
    const outcome = await run("complete");
    expect(outcome).toMatchObject({
      status: "completed",
      streamed: ["working"],
      calls: 2,
      runtime: { runtime: "workerd", cpuLimit: "enforced" },
    });
    expect(outcome.text).toContain("10");
  });

  it("says which APIs the chat has when the code names another", async () => {
    const outcome = await run("noSuchApi");
    expect(outcome.status).toBe("threw");
    expect(outcome.text).toContain("no API named env.mail");
  });

  it("ends a busy loop as cpu_exceeded on its CPU time while core keeps answering", async () => {
    const busy = run("busy");
    const answers: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another, during the loop
      answers.push(await answerTime());
    }
    const outcome = await busy;
    expect(outcome.status).toBe("cpu_exceeded");
    // Its 10 s of CPU, as on Cloudflare, not its minute of wall-clock time.
    expect(outcome.ms).toBeLessThan(15_000);
    expect(Math.max(...answers)).toBeLessThan(ANSWER_MS);
  }, 30_000);

  it("ends as the code did: it threw, or didn't load", async () => {
    await expect(run("throws")).resolves.toMatchObject({ status: "threw" });
    await expect(run("syntax")).resolves.toMatchObject({
      status: "load_failed",
    });
  });

  it("ends a run past its wall-clock time, and frees its process", async () => {
    const outcome = await run("waitsPastItsTime");
    expect(outcome.status).toBe("wall_expired");
    expect(outcome.ms).toBeLessThan(5000);
    await expect
      .poll(() => supervisor.stats().inFlight, { timeout: 3000 })
      .toBe(0);
  });

  it("ends a cancelled run, and frees its process", async () => {
    const outcome = await run("cancelled");
    expect(outcome.status).toBe("cancelled");
    expect(outcome.ms).toBeLessThan(3000);
    await expect
      .poll(() => supervisor.stats().inFlight, { timeout: 3000 })
      .toBe(0);
  });
});
