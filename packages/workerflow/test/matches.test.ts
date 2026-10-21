// Waits that take an event by its type and the attributes it was sent
// with (`waitForMatch`), through the run object's real boundary: each
// takes the oldest event that matches, sent before it was reached or
// after, and never one another wait took; an event that doesn't match
// stays in the inbox and wakes nothing.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import { encode } from "../src/codec.ts";
import type { EventMatch } from "../src/contracts.ts";
import type { InstanceEvent } from "../src/instance.ts";
import {
  alarmOf,
  ended,
  journalOf,
  newId,
  runObject,
  suspendedOn,
  workflow,
} from "./helpers.ts";
import { hold } from "./outside.ts";

const hourMs = 60 * 60 * 1000;

const started = async (
  match: EventMatch[],
  options: { until?: number; twice?: boolean } = {}
): Promise<string> => {
  const id = newId();
  await workflow("matches").create({
    id,
    params: {
      match,
      until: options.until ?? Date.now() + hourMs,
      twice: options.twice ?? false,
    },
  });
  return id;
};

const holds = new Map<string, () => void>();

/** As `started`, its first step held until `release`: events go in first. */
const held = async (
  match: EventMatch[],
  options: { twice?: boolean } = {}
): Promise<string> => {
  const id = newId();
  const before = hold(id, "before");
  holds.set(id, before.release);
  await workflow("matches").create({
    id,
    params: {
      match,
      until: Date.now() + hourMs,
      twice: options.twice ?? false,
    },
  });
  await before.held;
  return id;
};

const release = (id: string): void => {
  holds.get(id)?.();
};

const send = async (id: string, event: InstanceEvent): Promise<void> => {
  const run = await workflow("matches").get(id);
  await run.sendEvent(event);
};

const job = (subject: string): EventMatch => ({
  type: "job-completed",
  attributes: { subject },
});

/** Runs `change` on the run object's storage of the `approval` run `id`. */
const runInObject = async (
  id: string,
  change: (sql: SqlStorage) => void
): Promise<void> => {
  await runInDurableObject(runObject("approval", id), (_, state) => {
    change(state.storage.sql);
  });
};

describe("a wait for a match", () => {
  it("takes the oldest event of its type with every attribute it names, sent before it was reached too", async () => {
    const id = await started([job("job-1")]);
    await suspendedOn("matches", id, "first");

    // Another job's, another type, and one sent with no attributes: none
    // of them is the wait's.
    await send(id, {
      type: "job-completed",
      payload: "other job",
      attributes: { subject: "job-2" },
    });
    await send(id, {
      type: "job-failed",
      payload: "other type",
      attributes: { subject: "job-1" },
    });
    await send(id, { type: "job-completed", payload: "no attributes" });
    const waiting = await journalOf("matches", id);
    await send(id, {
      type: "job-completed",
      payload: "ours",
      attributes: { subject: "job-1", source: "https://example.com" },
    });

    await expect(ended("matches", id)).resolves.toStrictEqual({
      status: "complete",
      output: ["ours"],
    });
    const { steps, events } = await journalOf("matches", id);
    expect(waiting.run.status).toBe("waiting");
    expect(events.map((row) => row.consumed_by)).toStrictEqual([
      null,
      null,
      null,
      steps.find((step) => step.name === "first")?.ordinal,
    ]);
  });

  it("takes the first event, in the order they were accepted, that matches any of its entries", async () => {
    const created = await held([job("job-1"), job("job-2")]);
    await send(created, {
      type: "job-completed",
      payload: "second job first",
      attributes: { subject: "job-2" },
    });
    await send(created, {
      type: "job-completed",
      payload: "first job second",
      attributes: { subject: "job-1" },
    });
    release(created);

    await expect(ended("matches", created)).resolves.toStrictEqual({
      status: "complete",
      output: ["second job first"],
    });
  });

  it("gives an event that matches two waits to the first alone, and the next one to the second", async () => {
    const id = await held([{ type: "vote" }], { twice: true });
    await send(id, { type: "vote", payload: 1, attributes: { subject: "a" } });
    await send(id, { type: "vote", payload: 2 });
    await send(id, { type: "vote", payload: 3 });
    release(id);

    await expect(ended("matches", id)).resolves.toStrictEqual({
      status: "complete",
      output: [1, 2],
    });
    const { events } = await journalOf("matches", id);
    expect(events.map((event) => event.consumed_by !== null)).toStrictEqual([
      true,
      true,
      false,
    ]);
  });

  it("leaves a suspended run asleep for an event it doesn't match, and wakes it for one it does", async () => {
    const id = await started([job("job-1")]);
    const { deadline } = await suspendedOn("matches", id, "first");

    await send(id, {
      type: "job-completed",
      attributes: { subject: "job-1x" },
    });
    const asleep = await journalOf("matches", id);
    const alarm = await alarmOf("matches", id);
    await send(id, {
      type: "job-completed",
      payload: "woke",
      attributes: { subject: "job-1" },
    });

    expect({ status: asleep.run.status, alarm }).toStrictEqual({
      status: "waiting",
      alarm: deadline,
    });
    await expect(ended("matches", id)).resolves.toStrictEqual({
      status: "complete",
      output: ["woke"],
    });
  });

  it("times out at its deadline, journaled when it was first reached, and an event after it is late", async () => {
    const id = await started([job("job-1")], { until: Date.now() + 1500 });

    const status = await ended("matches", id);
    await send(id, {
      type: "job-completed",
      attributes: { subject: "job-1" },
    }).catch(() => {
      // An ended run takes none.
    });

    expect(status).toStrictEqual({
      status: "complete",
      output: {
        timedOut: {
          name: "WorkflowTimeoutError",
          message: "Execution timed out at its deadline",
        },
      },
    });
    const { events } = await journalOf("matches", id);
    expect(events).toStrictEqual([]);
  });

  it("refuses attributes outside CloudEvents' rule, and a match it can't keep", async () => {
    const id = await started([job("job-1")]);
    await suspendedOn("matches", id, "first");
    const run = await workflow("matches").get(id);

    const refusals = await Promise.all(
      [
        { Subject: "x" },
        { ["a".repeat(21)]: "x" },
        Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [`a${index}`, "x"])
        ),
        { subject: "x".repeat(1025) },
      ].map(async (attributes) => {
        try {
          await run.sendEvent({ type: "job-completed", attributes });
          return "accepted";
        } catch (error) {
          return error instanceof TypeError ? "refused" : String(error);
        }
      })
    );
    const empty = await started([]);

    expect(refusals).toStrictEqual(Array.from({ length: 4 }, () => "refused"));
    await expect(ended("matches", empty)).resolves.toMatchObject({
      status: "complete",
      output: { timedOut: { name: "TypeError" } },
    });
    const { events } = await journalOf("matches", id);
    expect(events).toStrictEqual([]);
  });

  it("takes a delivery sent again under its key once, and refuses its key with other attributes", async () => {
    const id = await started([job("job-1")], { twice: true });
    const run = await workflow("matches").get(id);
    const key = `delivery-${newId()}`;

    const first = await run.deliverEvent({
      type: "job-completed",
      payload: "once",
      attributes: { subject: "job-1" },
      key,
    });
    const again = await run.deliverEvent({
      type: "job-completed",
      payload: "once",
      attributes: { subject: "job-1" },
      key,
    });
    const other = await run
      .deliverEvent({
        type: "job-completed",
        payload: "once",
        attributes: { subject: "job-2" },
        key,
      })
      .then(() => "accepted", String);

    expect({ first, again }).toStrictEqual({
      first: { accepted: true },
      again: { accepted: false },
    });
    expect(other).toMatch(/other attributes/u);
    const { events } = await journalOf("matches", id);
    expect(events).toHaveLength(1);
  });

  it("counts the attributes an event was sent with as bytes of the run's inbox", async () => {
    const id = await started([job("job-1")]);
    await suspendedOn("matches", id, "first");
    await send(id, {
      type: "x",
      payload: null,
      attributes: { subject: "abc" },
    });

    const { run } = await journalOf("matches", id);
    expect(run.event_bytes).toBe(
      encode(null).length + JSON.stringify({ subject: "abc" }).length
    );
  });

  it("keeps a matching event that comes while the run is paused, wakes nothing with it, and takes it once resumed", async () => {
    const id = await started([job("job-1")]);
    await suspendedOn("matches", id, "first");
    const run = await workflow("matches").get(id);
    await run.pause();

    await send(id, {
      type: "job-completed",
      payload: "while paused",
      attributes: { subject: "job-1" },
    });
    const paused = await journalOf("matches", id);
    const alarm = await alarmOf("matches", id);
    await run.resume();

    expect({
      status: paused.run.status,
      alarm,
      taken: paused.events.map((event) => event.consumed_by),
    }).toStrictEqual({ status: "paused", alarm: null, taken: [null] });
    await expect(ended("matches", id)).resolves.toStrictEqual({
      status: "complete",
      output: ["while paused"],
    });
  });

  it("upgrades a version-9 journal as it first reads it, and takes events with attributes then", async () => {
    const id = newId();
    await workflow("approval").create({ id });
    await suspendedOn("approval", id, "approval");
    await runInObject(id, (sql) => {
      sql.exec("UPDATE run SET schema = 9");
      sql.exec("ALTER TABLE events DROP COLUMN attributes");
      sql.exec("ALTER TABLE steps DROP COLUMN event_match");
    });

    const approval = await workflow("approval").get(id);
    await approval.sendEvent({
      type: "approved",
      payload: "yes",
      attributes: { subject: "s" },
    });

    await expect(ended("approval", id)).resolves.toMatchObject({
      status: "complete",
      output: { approved: { payload: "yes" } },
    });
    const { run } = await journalOf("approval", id);
    expect(run.schema).toBe(10);
  });
});
