// Runs that live through process death: plain workerd on disk-backed
// storage, killed with SIGKILL at each durable commit and started again on
// the same directory, and runs that sleep or wait for an event through it
// with no process alive. Every wait polls with a deadline; the journal each
// test reads back is what recovery had to go on.
import { describe, expect, it } from "vite-plus/test";

import {
  attemptsOf,
  ended,
  journalOf,
  leaseMargin,
  onDisk,
  outside,
  pastTime,
  startOf,
  timeline,
  workerd,
} from "./death-harness.ts";

/**
 * The engine's `maxCutOffs` (src/config.ts), written out: these tests reach
 * the engine only through workerd, never its modules.
 */
const maxCutOffs = 10;

describe("a run on disk-backed workerd", () => {
  onDisk();

  it("retries an attempt cut off at once, spending none of its retries, even when it is found past its deadline", async () => {
    const id = "cut-off-past-its-deadline";
    const first = outside.hold(id, "stuck", 1);
    await workerd.request("/start", startOf("stuck", id));
    await first;
    // Killed while the attempt is out, well before its deadline; started
    // again only once that has passed, as after a slow restart.
    const [firstOut] = attemptsOf(await journalOf("stuck", id));
    await workerd.kill();
    await pastTime((firstOut?.deadline ?? Number.NaN) + leaseMargin);

    const second = outside.hold(id, "stuck", 2);
    await workerd.start();
    await second;
    const retried = attemptsOf(await journalOf("stuck", id));
    // Its one retry is still there: cut off again the same way.
    await workerd.kill();
    await pastTime((retried[1]?.deadline ?? Number.NaN) + leaseMargin);
    await workerd.start();
    const status = await ended("stuck", id);

    // The first, found cut off past its deadline, isn't counted as timed
    // out: the second went out in the write that found it, not after a
    // backoff.
    expect(retried).toMatchObject([
      { attempt: 1, ended: "superseded", retry_at: null },
      { attempt: 2, ended: null },
    ]);
    expect(retried[1]?.started_at).toBe(retried[0]?.ended_at);
    expect(status).toMatchObject({ status: "complete" });
    expect(timeline(id)).toStrictEqual([
      ["stuck", 1],
      ["stuck", 2],
      ["stuck", 3],
    ]);
    await expect(journalOf("stuck", id)).resolves.toMatchObject({
      steps: [{ name: "stuck", state: "succeeded", attempt: 3 }],
      attempts: [
        { attempt: 1, ended: "superseded" },
        { attempt: 2, ended: "superseded" },
        { attempt: 3, ended: "succeeded" },
      ],
    });
  });

  it("retries a step killed out from under each attempt up to its last cut-off allowed, then fails it, not to be retried, whatever its retries", async () => {
    const id = "cut-off-too-often";
    let held = outside.hold(id, "cut", 1);
    await workerd.request(
      "/start",
      startOf("cut-off", id, { params: { limit: 5 } })
    );
    for (let attempt = 1; attempt <= maxCutOffs; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
      await held;
      // Killed while the attempt is out, well before its minute is up.
      // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
      await workerd.kill();
      if (attempt < maxCutOffs) {
        held = outside.hold(id, "cut", attempt + 1);
      }
      // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
      await workerd.start();
    }
    const status = await ended("cut-off", id);

    const cutOffTooOften = {
      name: "WorkflowInternalError",
      message: `The step's attempts were cut off ${maxCutOffs} times before their outcome was journaled (the object running them was restarted or evicted), so it is not tried again`,
      code: "workflow.attempts_cut_off",
    };
    expect(status).toMatchObject({
      status: "errored",
      error: { name: cutOffTooOften.name, message: cutOffTooOften.message },
    });
    expect(timeline(id)).toStrictEqual(
      Array.from({ length: maxCutOffs }, (_, index) => ["cut", index + 1])
    );
    const journal = await journalOf("cut-off", id);
    expect(journal).toMatchObject({
      steps: [{ name: "cut", state: "failed", attempt: maxCutOffs }],
    });
    // Each cut-off but the last was retried at once; the last failed the
    // step, though none of its five retries was spent.
    expect(
      attemptsOf(journal).map(({ ended: end, retry_at: retryAt }) => ({
        end,
        retryAt,
      }))
    ).toStrictEqual([
      ...Array.from({ length: maxCutOffs - 1 }, () => ({
        end: "superseded",
        retryAt: null,
      })),
      { end: "failed", retryAt: null },
    ]);
    expect(attemptsOf(journal).at(-1)).toMatchObject({
      error: JSON.stringify(cutOffTooOften),
    });
  });
});
