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

const outcomeSchema = z.object({
  status: z.enum(["ok", "refused", "unavailable"]),
  value: z.unknown().optional(),
  message: z.string().optional(),
  ms: z.number(),
});

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

  const call = async (path: string) => {
    const response = await fetch(`${coreUrl}run?path=${path}`);
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

  it("runs a function that reads through its operation channel", async () => {
    const outcome = await call("echo");
    expect(outcome).toMatchObject({
      status: "ok",
      value: { args: { n: 1 }, read: { rows: ["one"] } },
    });
  });

  it("ends a busy-looping function on its CPU-time budget while core keeps answering", async () => {
    const busy = call("busy");
    const answers: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another, during the loop
      answers.push(await answerTime());
    }
    const outcome = await busy;
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toContain("CPU time");
    // Its 10 s of CPU, as Cloudflare gives a function, and not a minute.
    expect(outcome.ms).toBeLessThan(15_000);
    expect(Math.max(...answers)).toBeLessThan(ANSWER_MS);
  }, 30_000);
});
