import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runInSession } from "../../src/sandbox-session.ts";
import { sessionHost } from "../../src/sandboxed.ts";
import { mockIdpWith } from "../idp.ts";
import {
  endedRun,
  endLiveResourceRuns,
  greetingTasks,
  publishedWorkflow,
  startedBy,
} from "../json-workflow-apps.ts";
import { liveStatus } from "../runs.ts";
import { idp, runTime, signedIn } from "./workflow-run-sessions-harness.ts";

// An independent JSON workflow's runs on-prem, in their sessions: one per
// load, owned by the workflow, let go of while a run waits, and waited for
// while the sandbox is full. Runs, the engine, the host and the sandbox
// supervisor are real; a run is started through its builder's session.
// Already covered: a load across a wait, and a listen's event after it
// (json-workflow-runs.test.ts). Not yet shown for a JSON run (GRA-1585):
// a cancel stopping a run that waits for a place.

mockIdpWith(idp);

/**
 * Holds one of the sandbox's places as `owner`, spinning, until the
 * returned function lets go of it.
 */
const holdPlace = (owner: string): (() => Promise<void>) => {
  const giveUp = new AbortController();
  const host = sessionHost(env);
  if (host === undefined) {
    throw new Error("These tests run on-prem, with a sandbox host.");
  }
  const held = runInSession(
    host,
    {
      mainModule: "spin.js",
      modules: {
        "spin.js":
          'import { WorkerEntrypoint } from "cloudflare:workers"; export class Spin extends WorkerEntrypoint { async go() { for (;;) {} } }',
      },
      entrypoint: "Spin",
      method: "go",
      args: [],
      owner,
      cpuMs: 30_000,
      wallMs: 60_000,
    },
    { signal: giveUp.signal }
  ).catch(() => {
    // Let go of.
  });
  return async () => {
    giveUp.abort();
    await held;
  };
};

describe("an independent JSON workflow's runs on-prem", runTime, () => {
  afterEach(endLiveResourceRuns);

  it("waits for a place while the sandbox is full, then loads, rather than failing the run", async () => {
    const builder = await signedIn("builder");
    const { id } = await publishedWorkflow(builder, greetingTasks());
    // Both processes held, by calls of two others.
    const letGo = [holdPlace("app-full-a"), holdPlace("app-full-b")];
    const runId = await startedBy(builder, id);
    // Long enough for its load to be refused, the pool full, more than once.
    await scheduler.wait(8000);
    const whileFull = await liveStatus(runId);
    await Promise.all(
      letGo.map(async (free) => {
        await free();
      })
    );
    const run = await endedRun(builder, id, runId);
    expect({
      whileFull,
      after: { status: run.status, output: run.result },
    }).toStrictEqual({
      whileFull: "running",
      after: { status: "completed", output: { status: "Hello, Ada" } },
    });
  });
});
