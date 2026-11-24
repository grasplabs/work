// Sleeps and event waits through the run object's real boundary: a wait
// that isn't due suspends the run with no activation alive, and every
// alarm and event after replays to it. Process death and eviction while
// waiting are in test/process.
//
// Waits raced or awaited together; waits-replays.test.ts has the rest.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import {
  deliverAlarm,
  ended,
  journalOf,
  newId,
  runObject,
  suspendedOn,
  until,
  workflow,
} from "./helpers.ts";
import { effectsOf } from "./outside.ts";
import { send, labels, witnessed } from "./waits.ts";

describe("waits raced or awaited together", () => {
  it("run sleeps awaited together, each to its own deadline", async () => {
    const id = newId();
    await workflow("naps").create({ id });

    const status = await ended("naps", id);

    const { steps } = await journalOf("naps", id);
    expect(status).toStrictEqual({ status: "complete", output: "slept" });
    expect(
      steps.map(({ name, state, type }) => ({ name, state, type }))
    ).toStrictEqual([
      { name: "first", state: "succeeded", type: "sleep" },
      { name: "second", state: "succeeded", type: "sleep" },
    ]);
  });

  it("park a wait raced against a sleep, suspend until the earlier, and let an event win the race", async () => {
    const id = newId();
    await workflow("races").create({ id });
    const { journal } = await suspendedOn("races", id, "give-up");
    const reply = journal.steps.find(({ name }) => name === "reply");
    const giveUp = journal.steps.find(({ name }) => name === "give-up");
    // Both journaled before the run let go, and it wakes at the earlier.
    expect({
      reply: reply?.state,
      wake: journal.run.wake_at,
      earlier: Math.min(reply?.deadline ?? 0, giveUp?.deadline ?? 0),
    }).toMatchObject({ reply: "waiting" });
    expect(journal.run.wake_at).toBe(
      Math.min(reply?.deadline ?? 0, giveUp?.deadline ?? 0)
    );
    // Nothing of the author's handlers ran while the race was undecided.
    expect(witnessed(id)).toStrictEqual([]);

    await send("races", id, { type: "reply", payload: "yes" });
    const status = await ended("races", id);

    expect(status).toMatchObject({ status: "complete" });
    expect(witnessed(id)).toStrictEqual(["finally"]);
  });

  it("hand a race the same winner on every replay, as its outcomes were first journaled, across a kill", async () => {
    const id = newId();
    await workflow("sleep-race").create({ id });
    // The short sleep won; the long one comes due while "after" waits.
    await until("the long sleep to be due and journaled", async () => {
      const { steps } = await journalOf("sleep-race", id);
      return steps.find(({ name }) => name === "long")?.state === "succeeded"
        ? true
        : undefined;
    });
    // Replays with both outcomes read back from the journal, then one
    // after the object is killed.
    await deliverAlarm("sleep-race", id);
    await deliverAlarm("sleep-race", id);
    await runInDurableObject(runObject("sleep-race", id), (_, state) => {
      state.abort("killed");
    }).catch(() => null);

    const status = await ended("sleep-race", id);

    const { activations } = await journalOf("sleep-race", id);
    expect(status).toStrictEqual({ status: "complete", output: "short" });
    expect(activations.length).toBeGreaterThanOrEqual(5);
    // One witness for every activation from the short sleep's wake on.
    expect(witnessed(id)).toStrictEqual(
      Array.from({ length: activations.length - 1 }, () => "short")
    );
  });

  // The first run journals "a" first; a replay reaches "a" only after a
  // timer of its own, with "b" read back at once. "b" isn't held for a
  // call not yet made, and "a" is handed over once it is: nothing hangs.
  it.each([
    ["a timer before the earlier step", 0],
    ["random host latency before every call (1)", 15],
    ["random host latency before every call (2)", 15],
  ])(
    "hand over a sibling's saved outcome without holding it for an earlier one reached later: %s",
    async (_, jitter) => {
      const id = newId();
      await workflow("late-branch").create({ id, params: { jitter } });

      const status = await ended("late-branch", id);

      const { activations } = await journalOf("late-branch", id);
      expect(status).toStrictEqual({ status: "complete", output: ["a", "b"] });
      // Replayed past both steps: the sleep after them suspended the run.
      expect(activations.length).toBeGreaterThanOrEqual(2);
      // Each ran once, "a" first.
      expect(labels(id)).toStrictEqual(["a", "b"]);
    }
  );

  it.each([
    [true, 1],
    [false, 0],
  ])(
    "make a call the definition reaches after I/O of its own, said busy (%s), before suspending beside a sleep",
    async (busy, before) => {
      const id = newId();
      await workflow("busy-branch").create({ id, params: { busy } });

      const { journal } = await suspendedOn("busy-branch", id, "nap");

      // Said busy, the step runs before the run sleeps an hour; otherwise
      // it is left to the next activation.
      expect(effectsOf(id, "work")).toHaveLength(before);
      expect(journal.activations).toHaveLength(1);
    }
  );
});
