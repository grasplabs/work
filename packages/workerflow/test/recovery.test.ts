// Alarms delivered more than once, through the run object's real boundary.
// Process death and eviction mid-step are in test/process, on plain
// workerd: the Workers test pool runs objects in the test's own isolate,
// where resetting one mid-request takes the pool down with it.
import { describe, expect, it } from "vite-plus/test";

import {
  deliverAlarm,
  ended,
  journalOf,
  newId,
  until,
  workflow,
} from "./helpers.ts";
import { effectsOf, hold } from "./outside.ts";

/** Waits until the journal shows generation 1's activation has ended. */
const firstActivationEnded = async (definition: string, id: string) =>
  await until("the first activation to end", async () => {
    const journal = await journalOf(definition, id);
    return journal.activations[0]?.ended === null ? undefined : journal;
  });

describe("an alarm delivered again", () => {
  it("takes the run over while an activation is out, and the first one's late answer is ignored", async () => {
    const id = newId();
    const first = hold(id, "held");
    await workflow("catcher").create({ id });
    await first.held;

    // The duplicate delivery: another activation while the first waits.
    await deliverAlarm("catcher", id);
    const status = await ended("catcher", id);
    first.release();
    const journal = await firstActivationEnded("catcher", id);

    expect(status).toStrictEqual({
      status: "complete",
      output: effectsOf(id, "after")[0]?.receipt,
    });
    expect(journal).toMatchObject({
      activations: [
        { generation: 1, ended: "superseded" },
        { generation: 2, ended: "settled" },
      ],
      steps: [
        { name: "held", state: "succeeded", attempt: 2 },
        { name: "after", state: "succeeded", attempt: 1 },
      ],
      attempts: [
        { attempt: 1, generation: 1, ended: "superseded" },
        { attempt: 2, generation: 2, ended: "succeeded" },
        { attempt: 1, generation: 2, ended: "succeeded" },
      ],
    });
    // Both attempts at "held" went out under one key. The first
    // activation's catch and finally never ran: its step never settled.
    const held = effectsOf(id, "held");
    expect(new Set(held.map((effect) => effect.key)).size).toBe(1);
    expect(
      effectsOf(id).map((effect) => [effect.label, effect.attempt])
    ).toStrictEqual([
      ["held", 1],
      ["held", 2],
      ["finally", 0],
      ["after", 1],
    ]);
  });

  it("refuses an activation taken over between steps at its next step", async () => {
    const id = newId();
    const between = hold(id, "between");
    await workflow("pauses").create({ id });
    await between.held;

    await deliverAlarm("pauses", id);
    const status = await ended("pauses", id);
    between.release();
    const journal = await firstActivationEnded("pauses", id);

    // The first activation, let go after the second ended the run, got no
    // answer at "second": no effect, no finally, and the output stands.
    expect(journal.activations).toMatchObject([
      { generation: 1, ended: "superseded" },
      { generation: 2, ended: "settled" },
    ]);
    expect(
      effectsOf(id).map((effect) => [effect.label, effect.attempt])
    ).toStrictEqual([
      ["first", 1],
      ["second", 1],
      ["finally", 0],
    ]);
    const instance = await workflow("pauses").get(id);
    await expect(instance.status()).resolves.toStrictEqual(status);
  });

  it("can't end the run again when the activation it took over returns", async () => {
    const id = newId();
    const end = hold(id, "end");
    await workflow("tail").create({ id });
    await end.held;

    // The second activation reaches the end second, and returns 2.
    await deliverAlarm("tail", id);
    const status = await ended("tail", id);
    // The first one then returns 1, too late to count.
    end.release();
    const journal = await firstActivationEnded("tail", id);

    expect(status).toStrictEqual({ status: "complete", output: 2 });
    expect(journal.activations).toMatchObject([
      { generation: 1, ended: "superseded" },
      { generation: 2, ended: "settled" },
    ]);
    const instance = await workflow("tail").get(id);
    await expect(instance.status()).resolves.toStrictEqual(status);
  });

  it("changes nothing once the run has ended", async () => {
    const id = newId();
    await workflow("orders").create({ id });
    await ended("orders", id);
    const before = await journalOf("orders", id);

    await deliverAlarm("orders", id);

    await expect(journalOf("orders", id)).resolves.toStrictEqual(before);
    expect(effectsOf(id)).toHaveLength(2);
  });
});
