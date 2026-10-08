// Runs through the binding and the run object's real boundary: creating
// them, what their steps journal, and what callers see of them.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import { SerializationError } from "../src/codec.ts";
import { maxErrorMessageBytes } from "../src/errors.ts";
import {
  alarmOf,
  ended,
  journalOf,
  newId,
  runObject,
  until,
  workflow,
} from "./helpers.ts";
import { effectsOf, hold } from "./outside.ts";

const declined = { name: "PaymentError", message: "The card was declined" };

describe("a workflow run", () => {
  it("executes each step once and completes with what its definition returned", async () => {
    const id = newId();
    const instance = await workflow("orders").create({ id });

    const status = await ended("orders", id);

    const [charge, ship] = effectsOf(id);
    const journal = await journalOf("orders", id);
    expect({
      id: instance.id,
      status,
      effects: effectsOf(id).length,
    }).toStrictEqual({
      id,
      status: {
        status: "complete",
        output: { charge: charge?.receipt, ship: ship?.receipt },
      },
      effects: 2,
    });
    expect(journal).toMatchObject({
      run: { status: "complete", generation: 1 },
      activations: [{ generation: 1, ended: "settled" }],
      steps: [
        {
          name: "charge",
          occurrence: 1,
          state: "succeeded",
          attempt: 1,
          idempotency_key: charge?.key,
        },
        {
          name: "ship",
          occurrence: 1,
          state: "succeeded",
          attempt: 1,
          idempotency_key: ship?.key,
        },
      ],
    });
    // An ended run has nothing left to wake for.
    await expect(
      runInDurableObject(
        runObject("orders", id),
        async (_, state) => await state.storage.getAlarm()
      )
    ).resolves.toBeNull();
  });

  it("journals a step's failure by name and message, and lets the definition catch it", async () => {
    const id = newId();
    await workflow("declined").create({ id });

    const status = await ended("declined", id);

    expect(status).toStrictEqual({
      status: "complete",
      output: { declined, notified: effectsOf(id, "notify")[0]?.receipt },
    });
    expect(effectsOf(id, "charge")).toHaveLength(1);
    const { steps } = await journalOf("declined", id);
    expect(steps[0]).toMatchObject({
      name: "charge",
      state: "failed",
      error: JSON.stringify(declined),
    });
  });

  it("ends as errored, with the step's error, when the definition doesn't catch it", async () => {
    const id = newId();
    const instance = await workflow("uncaught").create({ id });

    await ended("uncaught", id);

    await expect(instance.status()).resolves.toStrictEqual({
      status: "errored",
      error: declined,
    });
  });

  it("fails a step whose value the journal can't keep with a SerializationError", async () => {
    const id = newId();
    await workflow("unkeepable").create({ id });

    await expect(ended("unkeepable", id)).resolves.toMatchObject({
      status: "complete",
      output: { name: "SerializationError" },
    });
  });

  it("gives each call of the same step name its own occurrence and key", async () => {
    const id = newId();
    await workflow("repeats").create({ id });

    const status = await ended("repeats", id);

    const sends = effectsOf(id, "send");
    const { steps } = await journalOf("repeats", id);
    expect(status).toStrictEqual({
      status: "complete",
      output: sends.map((send) => send.receipt),
    });
    expect(new Set(sends.map((send) => send.key)).size).toBe(2);
    expect(
      steps.map((step) => [step.name, step.occurrence, step.idempotency_key])
    ).toStrictEqual(sends.map((send, index) => ["send", index + 1, send.key]));
  });

  it("hands the definition its params, creation time and instance ID as they were at creation", async () => {
    const id = newId();
    const params = {
      when: new Date("2026-10-07T12:00:00.000Z"),
      bytes: new Uint8Array([0, 1, 254, 255]),
      tags: new Set(["a", "b"]),
      totals: new Map([["eur", 12n]]),
      missing: undefined,
    };
    await workflow("echo").create({ id, params });

    const status = await ended("echo", id);

    const { run } = await journalOf("echo", id);
    expect(status).toStrictEqual({
      status: "complete",
      output: {
        payload: params,
        timestamp: new Date(run.created_at),
        instanceId: id,
      },
    });
  });

  it.each([
    ["retries without a delay", { retries: { limit: 3 } }],
    ["a retry limit that isn't whole", { retries: { limit: 1.5, delay: 0 } }],
    ["a negative retry limit", { retries: { limit: -1, delay: 0 } }],
    [
      "a backoff it doesn't know",
      { retries: { limit: 1, delay: 0, backoff: "random" } },
    ],
    ["a delay that isn't a duration", { retries: { limit: 1, delay: "soon" } }],
    ["null retries", { retries: null }],
    ["a timeout of 0", { timeout: 0 }],
    [
      "a timeout longer than an attempt can run here",
      { timeout: "16 minutes" },
    ],
    ["a setting it doesn't know", { retry: { limit: 1, delay: 0 } }],
    ["a setting of a later slice", { sensitive: "output" }],
    ["null for a config", null],
  ])(
    "refuses a step configured with %s rather than run it otherwise",
    async (_, config) => {
      const id = newId();
      await workflow("misconfigured").create({ id, params: { config } });

      const status = await ended("misconfigured", id);

      expect(status).toMatchObject({
        status: "errored",
        error: { name: "TypeError" },
      });
      const { steps } = await journalOf("misconfigured", id);
      expect(steps).toStrictEqual([]);
    }
  );

  it("ends as errored when the host has no such definition", async () => {
    const id = newId();
    await workflow("nowhere").create({ id });

    await expect(ended("nowhere", id)).resolves.toStrictEqual({
      status: "errored",
      error: {
        name: "WorkflowDefinitionNotFound",
        message: 'There is no workflow definition "nowhere"',
      },
    });
  });

  it("ignores a step that answers after the run ended, and the definition never hears of it", async () => {
    const id = newId();
    const late = hold(id, "late");
    const end = hold(id, "end");
    await workflow("stray").create({ id });
    // The step's effect is out; only then does the definition return.
    await late.held;
    await end.held;
    end.release();

    const status = await ended("stray", id);
    late.release();

    const journal = await until("the late answer to be refused", async () => {
      const now = await journalOf("stray", id);
      return now.attempts[0]?.ended === null ? undefined : now;
    });
    expect(status).toStrictEqual({ status: "complete", output: "done" });
    expect(journal).toMatchObject({
      run: { status: "complete" },
      steps: [{ name: "late", state: "running" }],
      attempts: [{ attempt: 1, generation: 1, ended: "superseded" }],
    });
    expect(effectsOf(id).map((effect) => effect.label)).toStrictEqual(["late"]);
  });
});

describe("creating a run", () => {
  it("fails for an ID that exists, and the run still executes once", async () => {
    const id = newId();
    await workflow("orders").create({ id });

    await expect(workflow("orders").create({ id })).rejects.toThrow(
      /^instance\.already_exists/u
    );
    await ended("orders", id);
    expect(effectsOf(id)).toHaveLength(2);
  });

  it("makes the same instance ID under another definition another run", async () => {
    const id = newId();
    await workflow("orders").create({ id });
    await workflow("repeats").create({ id });

    await expect(ended("orders", id)).resolves.toMatchObject({
      status: "complete",
    });
    await expect(ended("repeats", id)).resolves.toMatchObject({
      status: "complete",
    });
  });

  it("finds the run a start created when the same start is delivered again; nothing runs twice", async () => {
    const id = newId();
    const admission = { id, key: `trigger-${newId()}`, params: { order: 7 } };
    const first = await workflow("orders").admit(admission);
    const again = await workflow("orders").admit(admission);
    await ended("orders", id);
    // Delivered again after the run ended, it still finds that run.
    const late = await workflow("orders").admit(admission);

    expect([first.created, again.created, late.created]).toStrictEqual([
      true,
      false,
      false,
    ]);
    expect(again.instance.id).toBe(id);
    expect(effectsOf(id)).toHaveLength(2);
    const { activations } = await journalOf("orders", id);
    expect(activations).toHaveLength(1);
  });

  it("finds the run when the start comes again with its params' keys in another order, nested too", async () => {
    const id = newId();
    const key = `trigger-${newId()}`;
    await workflow("orders").admit({
      id,
      key,
      params: {
        order: 7,
        customer: { name: "A", tier: "gold" },
        lines: [{ sku: "x", qty: 1 }],
      },
    });

    const again = await workflow("orders").admit({
      id,
      key,
      params: {
        lines: [{ qty: 1, sku: "x" }],
        customer: { tier: "gold", name: "A" },
        order: 7,
      },
    });

    expect(again).toMatchObject({ created: false });
  });

  it("keeps a Map's entry order part of the params: the same entries in another order are another start", async () => {
    const id = newId();
    const key = `trigger-${newId()}`;
    await workflow("orders").admit({
      id,
      key,
      params: new Map([
        ["a", 1],
        ["b", 2],
      ]),
    });

    await expect(
      workflow("orders").admit({
        id,
        key,
        params: new Map([
          ["b", 2],
          ["a", 1],
        ]),
      })
    ).rejects.toThrow(/made with other params/u);
  });

  it("refuses a start key reused with other params, and another key for the same ID", async () => {
    const id = newId();
    await workflow("orders").admit({ id, key: "k1", params: { order: 7 } });

    await expect(
      workflow("orders").admit({ id, key: "k1", params: { order: 8 } })
    ).rejects.toThrow(/made with other params/u);
    await expect(
      workflow("orders").admit({ id, key: "k2", params: { order: 7 } })
    ).rejects.toThrow(/^instance\.already_exists/u);
  });

  it("refuses invalid IDs, and params the journal can't keep, before any run exists", async () => {
    const id = newId();

    await expect(
      workflow("orders").create({ id: "-starts-with-a-dash" })
    ).rejects.toThrow(TypeError);
    await expect(
      workflow("orders").create({ id: "x".repeat(101) })
    ).rejects.toThrow(TypeError);
    await expect(
      workflow("orders").create({ id, params: { callback: () => "live" } })
    ).rejects.toThrow(SerializationError);
    await expect(workflow("orders").get(id)).rejects.toThrow(
      /^instance\.not_found/u
    );
  });

  it("leaves no journal behind when an instance that doesn't exist is looked up", async () => {
    const id = newId();

    await expect(workflow("orders").get(id)).rejects.toThrow(
      /^instance\.not_found/u
    );
    await expect(runObject("orders", id).journal()).resolves.toBeUndefined();
    await expect(
      runInDurableObject(runObject("orders", id), (_, state) =>
        state.storage.sql.exec("SELECT name FROM sqlite_master").toArray()
      )
    ).resolves.toStrictEqual([]);
  });
});

describe("a thrown value the journal can't keep as it is", () => {
  it.each(["bare-in-step", "bare-in-body"])(
    "ends the run cleanly when it can't be printed (%s)",
    async (definition) => {
      const id = newId();
      await workflow(definition).create({ id });

      const status = await ended(definition, id);

      expect(status).toStrictEqual({
        status: "errored",
        error: { name: "Error", message: "unprintable thrown value" },
      });
      await expect(alarmOf(definition, id)).resolves.toBeNull();
    }
  );

  it.each(["huge-in-step", "huge-in-body"])(
    "ends the run cleanly with the message cut to size (%s)",
    async (definition) => {
      const id = newId();
      await workflow(definition).create({ id });

      const status = await ended(definition, id);

      const error = status.status === "errored" ? status.error : undefined;
      const bytes = new TextEncoder().encode(error?.message).byteLength;
      expect(error?.name).toBe("7");
      expect(bytes).toBeGreaterThan(maxErrorMessageBytes - 4);
      expect(bytes).toBeLessThanOrEqual(maxErrorMessageBytes);
      await expect(alarmOf(definition, id)).resolves.toBeNull();
    }
  );
});
