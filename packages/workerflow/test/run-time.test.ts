// A run's time moved on by its host's test (`advanceClock`, run-time.ts)
// and its activation restarted as a fault (`restartActivation`), through
// the run object's real boundary: what comes due by the moved time runs
// now, without waiting for the wall clock, and a restart takes a new
// generation whose replay runs no journaled step again.
import { describe, expect, it } from "vite-plus/test";

import {
  ended,
  journalOf,
  newId,
  runObject,
  suspendedOn,
  until,
  workflow,
} from "./helpers.ts";
import { effectsOf, hold } from "./outside.ts";

/** An hour, in ms: the napper's sleep. */
const hour = 60 * 60 * 1000;

describe("a run's clock", () => {
  it("moved on past a sleep's deadline wakes it now, with no wall-clock wait", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    const { deadline } = await suspendedOn("napper", id, "nap");
    const began = Date.now();

    await runObject("napper", id).advanceClockBy(hour);
    const status = await ended("napper", id);

    expect(Date.now() - began).toBeLessThan(10_000);
    expect(status).toMatchObject({ status: "complete" });
    // The sleep's deadline is the one journaled as it began: the clock
    // moved on to it, the deadline didn't move.
    await expect(journalOf("napper", id)).resolves.toMatchObject({
      activations: [
        { generation: 1, ended: "suspended" },
        { generation: 2, ended: "settled" },
      ],
      steps: [
        { name: "before", state: "succeeded" },
        { name: "nap", state: "succeeded", deadline },
        { name: "after", state: "succeeded" },
      ],
    });
    expect(effectsOf(id).map(({ label }) => label)).toStrictEqual([
      "before",
      "after",
    ]);
  });

  it("moved on short of a sleep's deadline leaves it asleep", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    await suspendedOn("napper", id, "nap");

    await runObject("napper", id).advanceClockBy(hour / 2);

    await expect(journalOf("napper", id)).resolves.toMatchObject({
      run: { status: "waiting" },
    });
    expect(effectsOf(id).map(({ label }) => label)).toStrictEqual(["before"]);
  });
});

describe("a restart of a run's activation", () => {
  it("ends the activation that holds it and replays the journal in a new one: a journaled step doesn't run again", async () => {
    const id = newId();
    const between = hold(id, "between");
    await workflow("pauses").create({ id });
    // Held after "first" was journaled, on nothing of the engine's.
    await between.held;

    await runObject("pauses", id).restartNow();
    const status = await ended("pauses", id);
    between.release();

    expect(status).toMatchObject({ status: "complete" });
    const journal = await until("the first activation's end", async () => {
      const read = await journalOf("pauses", id);
      return read.activations.every(({ ended: end }) => end !== null)
        ? read
        : undefined;
    });
    // The restart took the run's generation itself, so the activation
    // that replays it is a generation later still.
    expect(journal.activations).toMatchObject([
      { generation: 1, ended: "superseded" },
      { generation: 3, ended: "settled" },
    ]);
    // "first" ran once, in the activation that was restarted; the one
    // released later got no answer at "second".
    expect(
      effectsOf(id).map((effect) => [effect.label, effect.attempt])
    ).toStrictEqual([
      ["first", 1],
      ["second", 1],
      ["finally", 0],
    ]);
  });
});
