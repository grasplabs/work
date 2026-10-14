// An attempt's lease (`WorkflowRun.attemptLease`), through the run's real
// boundary: what a host reads, from its attempt's own context, before it
// lets that attempt's code act. It holds while the attempt is the step's
// latest, not ended, of an activation that still holds the run; not once
// the attempt has its outcome, has timed out, or the run was taken over.
import { describe, expect, it } from "vite-plus/test";

import { ended, newId, until, workflow } from "./helpers.ts";
import { hold, leasesOf } from "./outside.ts";
import type { LeaseReading } from "./outside.ts";

/** Once the run's attempt has read its lease at `at`. */
const readAt = async (id: string, at: string): Promise<LeaseReading> =>
  await until(`${id} reading its lease ${at}`, () =>
    leasesOf(id).find((reading) => reading.at === at)
  );

describe("an attempt's lease", () => {
  it("holds while the attempt runs, with its generation and deadline, and not once its outcome is journaled", async () => {
    const id = newId();
    const checkpoint = hold(id, "lease");
    const before = Date.now();
    await workflow("leased").create({ id, params: { duration: "1 minute" } });
    await checkpoint.held;
    checkpoint.release();
    await ended("leased", id);

    const [started, after, returned] = leasesOf(id);
    expect({
      started: started?.lease?.generation,
      after: after?.lease?.generation,
      deadline:
        (started?.lease?.deadline ?? 0) >= before + 60_000 &&
        (started?.lease?.deadline ?? Infinity) <= Date.now() + 60_000,
      returned: returned?.lease,
    }).toStrictEqual({
      started: 1,
      after: 1,
      deadline: true,
      returned: undefined,
    });
  });

  it("doesn't hold for an attempt that timed out, though its code still runs", async () => {
    const id = newId();
    const checkpoint = hold(id, "lease");
    await workflow("leased").create({ id, params: { duration: 50 } });
    await checkpoint.held;
    const status = await ended("leased", id);
    checkpoint.release();

    const started = await readAt(id, "started");
    const late = await readAt(id, "after the checkpoint");
    expect({
      status: status.status,
      started: started.lease?.generation,
      late: late.lease,
    }).toStrictEqual({ status: "errored", started: 1, late: undefined });
  });

  it("doesn't hold once the run is terminated while the attempt runs", async () => {
    const id = newId();
    const checkpoint = hold(id, "lease");
    await workflow("leased").create({ id, params: { duration: "1 minute" } });
    await checkpoint.held;
    const run = await workflow("leased").get(id);
    await run.terminate();
    checkpoint.release();

    const started = await readAt(id, "started");
    const late = await readAt(id, "after the checkpoint");
    const { status } = await run.status();
    expect({
      started: started.lease?.generation,
      late: late.lease,
      status,
    }).toStrictEqual({ started: 1, late: undefined, status: "terminated" });
  });

  it("holds while a pause waits for the attempt to finish", async () => {
    const id = newId();
    const checkpoint = hold(id, "lease");
    await workflow("leased").create({ id, params: { duration: "1 minute" } });
    await checkpoint.held;
    const run = await workflow("leased").get(id);
    await run.pause();
    // Still its activation's: a pause waits for the steps it has out.
    const { status: pausing } = await run.status();
    checkpoint.release();
    const after = await readAt(id, "after the checkpoint");

    expect({ pausing, after: after.lease?.generation }).toStrictEqual({
      pausing: "waitingForPause",
      after: 1,
    });
  });
});
