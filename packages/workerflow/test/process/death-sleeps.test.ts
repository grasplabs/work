// Runs that live through process death: plain workerd on disk-backed
// storage, killed with SIGKILL at each durable commit and started again on
// the same directory, and runs that sleep or wait for an event through it
// with no process alive. Every wait polls with a deadline; the journal each
// test reads back is what recovery had to go on.
import { describe, expect, it } from "vite-plus/test";

import {
  asleepAt,
  ended,
  journalOf,
  onDisk,
  outside,
  startOf,
  stepsOf,
  timeline,
  workerd,
} from "./death-harness.ts";
import { until } from "./outside.ts";

describe("a run on disk-backed workerd", () => {
  onDisk();

  it("neither brings a sleep forward nor puts it back when the process restarts before its deadline", async () => {
    const id = "restarted-before-the-deadline";
    // Long enough that a restart, however slow the machine, lands before
    // the deadline.
    await workerd.request(
      "/start",
      startOf("napper", id, { params: { order: id, nap: 10_000 } })
    );
    const deadline = await asleepAt("napper", id, "nap");

    await workerd.restart();
    const restarted = Date.now();
    const after = await until(
      "after to go out",
      () => outside.of(id, "after")[0]
    );
    await ended("napper", id);

    expect(restarted).toBeLessThan(deadline);
    expect(after.at).toBeGreaterThanOrEqual(deadline);
    expect(stepsOf(await journalOf("napper", id))).toMatchObject([
      { name: "before" },
      { name: "nap", deadline },
      { name: "after" },
    ]);
  });

  it("wakes a sleep on time after its object was evicted", async () => {
    const id = "asleep-when-evicted";
    await workerd.request("/start", startOf("napper", id));
    const deadline = await asleepAt("napper", id, "nap");

    await workerd.request(`/evict?definition=napper&id=${id}`, {});
    const after = await until(
      "after to go out",
      () => outside.of(id, "after")[0]
    );
    const status = await ended("napper", id);

    expect(after.at).toBeGreaterThanOrEqual(deadline);
    expect(status).toMatchObject({ status: "complete" });
    expect(timeline(id)).toStrictEqual([
      ["before", 1],
      ["after", 1],
    ]);
  });
});
