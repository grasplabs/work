/**
 * A workflow's runs on-prem, for the tests shared by the files they are
 * split across: each holds a run or two past a step's CPU time, too long
 * for one file to run them all.
 *
 * Each load of a run (its start, and each resume after a wait) runs as a
 * sandbox session owned by its App, through the real engine and host, with
 * `SANDBOX_HOST` bound to the sandbox supervisor this project starts. Its
 * two processes give each owner (an App's runs, the App's other calls) one
 * session at a time.
 */
import { runInDurableObject } from "cloudflare:test";
import { expect, vi } from "vite-plus/test";

import { release } from "../apps.ts";
import { allEvents } from "../audit-events.ts";
import type { Idp } from "../idp.ts";
import { liveStatus, runObject } from "../runs.ts";
import { signedInApi } from "../sign-in.ts";
import { workflowFiles } from "../workflow-apps.ts";

/** A builder's new App, signed in through `idp`, with `files` as its current version. */
export const appsOf = (idp: Idp) => async (files: Record<string, string>) => {
  const builder = await signedInApi(idp, "builder");
  const { id } = await builder.api.apps.create({ name: "Runs" });
  await release(builder, id, files);
  return { builder, app: id };
};

/** The steps of `run` the audit log has, each as its action and step. */
export const stepsOf = async (run: string): Promise<string[]> => {
  const events = await allEvents();
  return events.flatMap(({ action, target, detail }) =>
    action.startsWith("workflow.step.") && target?.id === run
      ? [`${action} ${String(detail.step)}`]
      : []
  );
};

/**
 * Once the run has ended: as `finished`, with room for a step's CPU time
 * (30 s) to run out first.
 */
export const endedPastCpuTime = async (run: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      expect(["complete", "errored", "terminated"]).toContain(
        await liveStatus(run)
      );
    },
    { timeout: 60_000, interval: 500 }
  );
};

/** The step `name` as the engine journaled it: its state and attempts. */
export const journaled = async (run: string, name: string) =>
  await runInDurableObject(runObject(run), (_object, state) =>
    state.storage.sql
      .exec<{
        state: string;
        attempt: number;
      }>("SELECT state, attempt FROM steps WHERE name = ?", name)
      .toArray()
  );

/** A workflow of one step, as `workflowFiles` writes it. */
export const oneStep = workflowFiles(
  "single",
  `  return await step.do("only", { description: "The only step" }, async () => "done");`,
  { only: "done" }
);

// Each test builds its App's workflows and runs their tests on the
// sandbox, then runs them: a minute is room for a slow runner.
export const runTime = { timeout: 90_000 };
