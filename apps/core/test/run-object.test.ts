import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { busyRefusalsIn } from "../src/workflows/run-object.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns, finished, runObject, sleeping } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// What core keeps in a run's object beside the engine's journal (a step's
// last busy-budget refusal) goes when the engine removes the run: nothing
// of it outlives the run's retention, though its start's tombstone stays.

const idp = mockIdp();

const napper = workflowFiles(
  "napper",
  `  await step.do("first", { description: "First" }, async () => null);
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return null;`,
  { first: null }
);

/** The object's tables, and what its key-value storage holds. */
const leftIn = async (run: string) =>
  await runInDurableObject(runObject(run), (_object, state) => ({
    tables: state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
      )
      .toArray()
      .map(({ name }) => name),
    kv: [...state.storage.kv.list()].length,
  }));

describe("a run's object", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("keeps a step's busy-budget refusal with the run, and drops it with the run's purge", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, napper);
    const { id: run } = await builder.api.workflows.start(app, "napper");
    await sleeping(run, "go");

    const kept = await runInDurableObject(runObject(run), (_object, state) => {
      const refusals = busyRefusalsIn(state.storage.sql);
      refusals.set("first", {
        at: 1,
        details: { reason: "model.budget_busy" },
      });
      return refusals.get("first");
    });
    await builder.api.workflows.cancel(run);
    await finished(run);
    // Its retention over: the purge's alarm comes due.
    await runInDurableObject(runObject(run), (_object, state) => {
      state.storage.sql.exec("UPDATE run SET purge_at = ?", Date.now() - 1);
    });
    await runDurableObjectAlarm(runObject(run));

    expect({ kept, left: await leftIn(run) }).toStrictEqual({
      kept: { at: 1, details: { reason: "model.budget_busy" } },
      // Only the start's tombstone, which the engine keeps for 30 days.
      left: { tables: ["tombstones"], kv: 0 },
    });
  });
});
