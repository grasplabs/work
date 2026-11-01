// Sleeps and event waits through the run object's real boundary: a wait
// that isn't due suspends the run with no activation alive, and every
// alarm and event after replays to it. Process death and eviction while
// waiting are in test/process.
//
// An event wait's inbox and each sender's share of it.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import { encode } from "../src/codec.ts";
import {
  maxEventPayloadBytes,
  maxInboxBytes,
  maxInboxEvents,
  maxSenderBytes,
  maxSenderEvents,
} from "../src/journal.ts";
import { WorkflowRun } from "../src/run.ts";
import {
  ended,
  journalOf,
  newId,
  runObject,
  suspendedOn,
  workflow,
} from "./helpers.ts";
import { instance, send } from "./waits.ts";

/** Encoded text of `bytes` bytes, as the binding would send it. */
const payloadOf = (bytes: number): string =>
  JSON.stringify([1, "x".repeat(bytes - '[1,""]'.length)]);

/** Sends straight to the run object, past the binding's own checks. */
const sendAll = async (
  id: string,
  payloads: string[],
  reserved = false,
  type = "spam",
  sender: string | null = null
): Promise<string[]> =>
  await runInDurableObject(runObject("approval", id), async (run) => {
    if (!(run instanceof WorkflowRun)) {
      throw new TypeError("the object isn't a run object");
    }
    const outcomes: string[] = [];
    for (const payload of payloads) {
      // oxlint-disable-next-line no-await-in-loop -- in order, as a sender would
      const outcome = await run.sendEvent({
        type,
        payload,
        key: null,
        reserved,
        sender,
      });
      outcomes.push(outcome);
    }
    return outcomes;
  });

describe("an inbox", () => {
  it("refuses a payload over the limit, measured on its encoded bytes", async () => {
    const id = newId();
    await workflow("approval").create({ id });

    // Characters of two bytes: within the limit in length, over it in bytes.
    const wide = JSON.stringify([1, "é".repeat(maxEventPayloadBytes / 2)]);
    const outcomes = await sendAll(id, [payloadOf(maxEventPayloadBytes), wide]);

    expect(wide.length).toBeLessThan(maxEventPayloadBytes);
    expect(outcomes).toStrictEqual(["accepted", "too_large"]);
  });

  it("stops taking events at its byte limit, and the caller hears why; a reserved delivery still fits", async () => {
    const id = newId();
    await workflow("approval").create({ id });
    const bytes = 1_000_000;
    const fit = Math.floor(maxInboxBytes / bytes);

    const outcomes = await sendAll(
      id,
      Array.from({ length: fit + 1 }, () => payloadOf(bytes))
    );

    expect(outcomes.filter((outcome) => outcome === "accepted")).toHaveLength(
      fit
    );
    expect(outcomes.at(-1)).toBe("full");
    // The counters the limits are checked against, kept with each event.
    const { run } = await journalOf("approval", id);
    expect([run.event_count, run.event_bytes]).toStrictEqual([
      fit,
      fit * bytes,
    ]);
    // Through the binding: one more payload of that size doesn't fit.
    await expect(
      send("approval", id, { type: "spam", payload: "x".repeat(bytes) })
    ).rejects.toThrow(/^instance\.inbox_full/u);
    // What the run's host owes it still finds room.
    await expect(sendAll(id, [payloadOf(bytes)], true)).resolves.toStrictEqual([
      "accepted",
    ]);
  });

  it("stops taking events at its count limit, and takes reserved deliveries past it however many", async () => {
    const id = newId();
    await workflow("approval").create({ id });

    const outcomes = await sendAll(
      id,
      Array.from({ length: maxInboxEvents + 1 }, () => encode(null))
    );
    // As many as a lineage's children: each past the limit.
    const reserved = await sendAll(
      id,
      Array.from({ length: 8 }, () => encode(null)),
      true
    );

    expect(outcomes.lastIndexOf("accepted")).toBe(maxInboxEvents - 1);
    expect(outcomes.at(-1)).toBe("full");
    expect(reserved).toStrictEqual(Array.from({ length: 8 }, () => "accepted"));
  });

  it("counts only what senders sent against its limits: a reserved delivery at the limit leaves ordinary ones their room", async () => {
    const id = newId();
    await workflow("approval").create({ id });

    const filled = await sendAll(
      id,
      Array.from({ length: maxInboxEvents - 1 }, () => encode(null))
    );
    const reserved = await sendAll(id, [encode(null)], true);
    const after = await sendAll(id, [encode(null), encode(null)]);

    expect({
      filled: filled.every((outcome) => outcome === "accepted"),
      reserved,
      after,
    }).toStrictEqual({
      filled: true,
      reserved: ["accepted"],
      after: ["accepted", "full"],
    });
  });

  it("leaves reserved deliveries out of its counts when a restart counts them again", async () => {
    const id = newId();
    await workflow("approval").create({ id });
    await suspendedOn("approval", id, "approval");
    const payload = encode("yes");
    await sendAll(id, [payload], true, "approved");
    await ended("approval", id);

    const run = await instance("approval", id);
    await run.restart({ from: { name: "after" } });
    await ended("approval", id);
    const { run: row, events } = await journalOf("approval", id);

    expect({
      kept: events.length,
      counts: [row.event_count, row.event_bytes],
    }).toStrictEqual({ kept: 1, counts: [0, 0] });
  });
});

describe("a sender's share of an inbox", () => {
  it("refuses one sender past its share of the count, and still takes another sender's events and the host's own", async () => {
    const id = newId();
    await workflow("approval").create({ id });

    const filled = await sendAll(
      id,
      Array.from({ length: maxSenderEvents + 1 }, () => encode(null)),
      false,
      "spam",
      "screen-a"
    );
    const other = await sendAll(id, [encode(null)], false, "spam", "screen-b");
    const reserved = await sendAll(
      id,
      [encode(null)],
      true,
      "spam",
      "screen-a"
    );
    const unnamed = await sendAll(id, [encode(null)]);

    expect({
      accepted: filled.filter((outcome) => outcome === "accepted").length,
      last: filled.at(-1),
      other,
      reserved,
      unnamed,
    }).toStrictEqual({
      accepted: maxSenderEvents,
      last: "full",
      other: ["accepted"],
      reserved: ["accepted"],
      unnamed: ["accepted"],
    });
  });

  it("refuses one sender past its share of the bytes, before the inbox is full", async () => {
    const id = newId();
    await workflow("approval").create({ id });
    const bytes = 1_000_000;
    const fit = Math.floor(maxSenderBytes / bytes);

    const outcomes = await sendAll(
      id,
      Array.from({ length: fit + 1 }, () => payloadOf(bytes)),
      false,
      "spam",
      "screen-a"
    );
    const other = await sendAll(
      id,
      [payloadOf(bytes)],
      false,
      "spam",
      "screen-b"
    );

    expect({
      accepted: outcomes.filter((outcome) => outcome === "accepted").length,
      last: outcomes.at(-1),
      other,
    }).toStrictEqual({ accepted: fit, last: "full", other: ["accepted"] });
    expect(fit * bytes).toBeLessThan(maxInboxBytes);
  });
});
