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

describe("a run on disk-backed workerd", () => {
  onDisk();

  it("counts an attempt cut off past its deadline as timed out, backs off, and fails the step once its retries are spent", async () => {
    const id = "cut-off-past-its-deadline";
    const first = outside.hold(id, "stuck", 1);
    await workerd.request("/start", startOf("stuck", id));
    await first;
    // Killed while the attempt is out, well before its deadline.
    const [firstOut] = attemptsOf(await journalOf("stuck", id));
    await workerd.kill();
    await pastTime((firstOut?.deadline ?? Number.NaN) + leaseMargin);

    const second = outside.hold(id, "stuck", 2);
    await workerd.start();
    await second;
    const retried = attemptsOf(await journalOf("stuck", id));
    await workerd.kill();
    await pastTime((retried[1]?.deadline ?? Number.NaN) + leaseMargin);
    await workerd.start();
    const status = await ended("stuck", id);

    const timedOut = {
      name: "WorkflowTimeoutError",
      message: "Execution timed out after 5000ms",
    };
    // The first, found past its deadline, ended as timed out; the second
    // came after its backoff, not at once.
    expect(retried).toMatchObject([
      { attempt: 1, ended: "timed_out", error: JSON.stringify(timedOut) },
      { attempt: 2, ended: null },
    ]);
    expect(retried[1]?.started_at).toBeGreaterThanOrEqual(
      retried[0]?.retry_at ?? Number.NaN
    );
    expect(status).toStrictEqual({ status: "errored", error: timedOut });
    expect(timeline(id)).toStrictEqual([
      ["stuck", 1],
      ["stuck", 2],
    ]);
    await expect(journalOf("stuck", id)).resolves.toMatchObject({
      steps: [{ name: "stuck", state: "failed", attempt: 2 }],
      attempts: [
        { attempt: 1, ended: "timed_out" },
        { attempt: 2, ended: "timed_out", retry_at: null },
      ],
    });
  });

  it.each([0, 1])(
    "fails a step cut off before its deadline on the last attempt its limit of %i retries allows, rather than retry it",
    async (limit) => {
      const id = `cut-off-on-its-last-attempt-${limit}`;
      const first = outside.hold(id, "cut", 1);
      await workerd.request(
        "/start",
        startOf("cut-off", id, { params: { limit } })
      );
      await first;
      // Killed while the attempt is out, well before its minute is up.
      await workerd.kill();
      if (limit === 1) {
        // The one retry goes out at once, and is cut off the same way.
        const second = outside.hold(id, "cut", 2);
        await workerd.start();
        await second;
        await workerd.kill();
      }
      await workerd.start();
      const status = await ended("cut-off", id);

      const cutOff = {
        name: "WorkflowInternalError",
        message: "Attempt failed due to internal workflows error",
      };
      expect(status).toStrictEqual({ status: "errored", error: cutOff });
      expect(timeline(id)).toStrictEqual(
        Array.from({ length: limit + 1 }, (_, index) => ["cut", index + 1])
      );
      const journal = await journalOf("cut-off", id);
      expect(journal).toMatchObject({
        steps: [{ name: "cut", state: "failed", attempt: limit + 1 }],
      });
      // Each attempt but the last was retried at once, with no end of its
      // own; the last is ended as failed, before its deadline.
      const attempts = attemptsOf(journal);
      expect(attempts.map((attempt) => attempt.ended)).toStrictEqual([
        ...Array.from({ length: limit }, () => null),
        "failed",
      ]);
      expect(attempts.at(-1)).toMatchObject({
        error: JSON.stringify(cutOff),
        retry_at: null,
      });
    }
  );
});
