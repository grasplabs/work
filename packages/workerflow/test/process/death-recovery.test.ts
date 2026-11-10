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
  keysOf,
  leaseMargin,
  leaseOf,
  onDisk,
  outside,
  retryDueAt,
  sha256Of,
  startOf,
  timeline,
  workerd,
} from "./death-harness.ts";
import { streamed, until } from "./outside.ts";

describe("a run on disk-backed workerd", () => {
  onDisk();

  it("doesn't run a step again while it outlasts its lease in a live activation", async () => {
    const id = "outlasts-its-lease";
    const shipHeld = outside.hold(id, "ship", 1);
    await workerd.request("/start", startOf("orders", id));
    await shipHeld;
    const leaseUntil = leaseOf(await journalOf("orders", id));

    // The watchdog's time passes, well past, with the activation alive:
    // workerd delivers no alarm while the object's alarm handler runs.
    await until("the lease to lapse", () =>
      Date.now() > leaseUntil + leaseMargin ? true : undefined
    );
    outside.release(id, "ship");
    const status = await ended("orders", id);

    expect(status).toMatchObject({ status: "complete" });
    expect(timeline(id)).toStrictEqual([
      ["charge", 1],
      ["ship", 1],
    ]);
  });

  it("never completes a step from an upload cut off by process death; the next attempt keeps the whole stream", async () => {
    const id = "upload-cut-off";
    const exportHeld = outside.hold(id, "export", 1);
    await workerd.request("/start", startOf("export", id));
    await exportHeld;
    // Part of the stream is stored, durably (the answer leaves only once
    // its writes are), when the process dies: the two whole chunks of the
    // first part sent.
    const partial = await until("part of the upload to be stored", async () => {
      const { body } = await workerd.request(
        `/chunks?definition=export&id=${id}`
      );
      return JSON.stringify(body).includes('"chunks":2') ? body : undefined;
    });
    const cutOff = await journalOf("export", id);
    await workerd.kill();
    await workerd.start();

    const status = await ended("export", id);

    expect({ partial, cutOff }).toMatchObject({
      partial: [{ ordinal: 1, attempt: 1, chunks: 2, length: 512 * 1024 }],
      cutOff: {
        steps: [{ name: "export", state: "running", attempt: 1, value: null }],
      },
    });
    // Both attempts at the download went out under one key.
    expect({
      timeline: timeline(id),
      keys: keysOf(id, "export").size,
    }).toStrictEqual({
      timeline: [
        ["export", 1],
        ["export", 2],
        ["digest", 1],
      ],
      keys: 1,
    });
    // The step read back the whole stream, from the attempt that finished.
    expect(status).toStrictEqual({
      status: "complete",
      output: { sha256: sha256Of(streamed), length: streamed.byteLength },
    });
    await expect(journalOf("export", id)).resolves.toMatchObject({
      steps: [
        { name: "export", state: "succeeded", attempt: 2 },
        { name: "digest", state: "succeeded", attempt: 1 },
      ],
      attempts: [
        { ordinal: 1, attempt: 1, ended: null },
        { ordinal: 1, attempt: 2, ended: "succeeded" },
        { ordinal: 2, attempt: 1, ended: "succeeded" },
      ],
    });
    // The cut-off upload is gone; only the kept attempt's chunks remain.
    await expect(
      workerd.request(`/chunks?definition=export&id=${id}`)
    ).resolves.toMatchObject({
      body: [
        {
          ordinal: 1,
          attempt: 2,
          chunks: Math.ceil(streamed.byteLength / (256 * 1024)),
          length: streamed.byteLength,
        },
      ],
    });
  });

  it("reads a stream result back from storage after eviction: a fresh, verified stream with its hash, length and encoding", async () => {
    const id = "stream-after-eviction";
    const digestHeld = outside.hold(id, "digest", 1);
    await workerd.request("/start", startOf("export", id));
    await digestHeld;

    await workerd.request(`/evict?definition=export&id=${id}`, {});
    await until("digest to go out again", () =>
      outside.of(id, "digest").find((effect) => effect.attempt === 2)
    );
    const status = await ended("export", id);
    // Evicted again: the host's own reading is fresh from storage too.
    await workerd.request(`/evict?definition=export&id=${id}`, {});
    const output = await workerd.bytes(
      `/output?definition=export&id=${id}&name=export`
    );

    // The replay didn't fetch the stream again: it read what was kept.
    expect(timeline(id)).toStrictEqual([
      ["export", 1],
      ["digest", 1],
      ["digest", 2],
    ]);
    expect(status).toStrictEqual({
      status: "complete",
      output: { sha256: sha256Of(streamed), length: streamed.byteLength },
    });
    expect({
      status: output.status,
      length: output.headers.get("x-length"),
      sha256: output.headers.get("x-sha256"),
      encoding: output.headers.get("x-encoding"),
      body: sha256Of(output.body),
    }).toStrictEqual({
      status: 200,
      length: String(streamed.byteLength),
      sha256: sha256Of(streamed),
      encoding: "identity",
      body: sha256Of(streamed),
    });
  });

  it("survives a kill at every step, and each step that completed ran once", async () => {
    const id = "killed-repeatedly";
    const chargeHeld = outside.hold(id, "charge", 1);
    const shipHeld = outside.hold(id, "ship", 1);
    await workerd.request("/start", startOf("orders", id));
    await chargeHeld;
    await workerd.restart();
    await shipHeld;
    await workerd.restart();

    const status = await ended("orders", id);

    const [, charge, , ship] = outside.of(id);
    expect(timeline(id)).toStrictEqual([
      ["charge", 1],
      ["charge", 2],
      ["ship", 1],
      ["ship", 2],
    ]);
    expect(status).toStrictEqual({
      status: "complete",
      output: { charge: charge?.receipt, ship: ship?.receipt },
    });
    await expect(journalOf("orders", id)).resolves.toMatchObject({
      activations: [
        { generation: 1, ended: null },
        { generation: 2, ended: null },
        { generation: 3, ended: "settled" },
      ],
    });
  });

  it("wakes a sleep on time after the process died, with no request reaching it, its deadline as journaled", async () => {
    const id = "asleep-when-killed";
    await workerd.request("/start", startOf("napper", id));
    const deadline = await asleepAt("napper", id, "nap");
    await workerd.kill();

    // No process at all until the deadline is well past.
    await until("the deadline to pass", () =>
      Date.now() > deadline + leaseMargin ? true : undefined
    );
    await workerd.start();
    const after = await until(
      "after to go out",
      () => outside.of(id, "after")[0]
    );
    const status = await ended("napper", id);

    expect(after.at).toBeGreaterThanOrEqual(deadline);
    expect(timeline(id)).toStrictEqual([
      ["before", 1],
      ["after", 1],
    ]);
    expect(status).toMatchObject({ status: "complete" });
    await expect(journalOf("napper", id)).resolves.toMatchObject({
      activations: [
        { generation: 1, ended: "suspended" },
        { generation: 2, ended: "settled" },
      ],
      steps: [
        { name: "before", attempt: 1 },
        { name: "nap", state: "succeeded", deadline },
        { name: "after", attempt: 1 },
      ],
    });
  });

  it("retries a failed step at the time journaled before the process died, with no request reaching it", async () => {
    const id = "retrying-when-killed";
    await workerd.request("/start", startOf("flaky", id));
    const retryAt = await retryDueAt("flaky", id);
    await workerd.kill();

    // No process at all until the retry is well past due.
    await until("the retry to be due", () =>
      Date.now() > retryAt + leaseMargin ? true : undefined
    );
    await workerd.start();
    const retry = await until("the retry to go out", () =>
      outside.of(id, "flaky").find((effect) => effect.attempt === 2)
    );
    const status = await ended("flaky", id);

    expect(retry.at).toBeGreaterThanOrEqual(retryAt);
    expect(timeline(id)).toStrictEqual([
      ["flaky", 1],
      ["flaky", 2],
    ]);
    expect(keysOf(id, "flaky").size).toBe(1);
    expect(status).toStrictEqual({ status: "complete", output: retry.receipt });
    // The retry's time, as journaled before the kill, never computed again.
    await expect(journalOf("flaky", id)).resolves.toMatchObject({
      activations: [
        { generation: 1, ended: "suspended" },
        { generation: 2, ended: "settled" },
      ],
      attempts: [
        { attempt: 1, generation: 1, ended: "failed", retry_at: retryAt },
        { attempt: 2, generation: 2, ended: "succeeded" },
      ],
    });
  });

  it("takes an event sent after the process died while the run waited, once however often it is delivered", async () => {
    const id = "waiting-when-killed";
    const delivery = {
      definition: "approval",
      id,
      type: "approved",
      payload: { by: "ann" },
      key: `delivery-${id}`,
    };
    await workerd.request("/start", startOf("approval", id));
    await asleepAt("approval", id, "approval");
    await workerd.restart();

    const sent = await workerd.request("/event", delivery);
    const status = await ended("approval", id);
    const again = await workerd.request("/event", delivery);
    const unkeyed = await workerd.request("/event", {
      definition: "approval",
      id,
      type: "approved",
    });

    expect({ sent, again }).toStrictEqual({
      sent: { status: 200, body: { accepted: true } },
      again: { status: 200, body: { accepted: false } },
    });
    expect(unkeyed.status).toBe(409);
    expect(JSON.stringify(unkeyed.body)).toMatch(/instance\.not_running/u);
    expect(status).toStrictEqual({
      status: "complete",
      output: {
        approved: { by: "ann" },
        after: outside.of(id, "after")[0]?.receipt,
      },
    });
    expect(timeline(id)).toStrictEqual([
      ["before", 1],
      ["after", 1],
    ]);
  });

  it("replays the event a wait took after the process died, though another of its type arrived before the kill", async () => {
    const id = "event-taken-before-the-kill";
    const afterHeld = outside.hold(id, "after", 1);
    const event = (payload: string) => ({
      definition: "approval",
      id,
      type: "approved",
      payload,
    });
    await workerd.request("/start", startOf("approval", id));
    await asleepAt("approval", id, "approval");
    await workerd.request("/event", event("first"));
    await afterHeld;
    await workerd.request("/event", event("second"));

    await workerd.restart();
    const status = await ended("approval", id);

    expect(status).toMatchObject({
      status: "complete",
      output: { approved: "first" },
    });
    expect(timeline(id)).toStrictEqual([
      ["before", 1],
      ["after", 1],
      ["after", 2],
    ]);
    await expect(journalOf("approval", id)).resolves.toMatchObject({
      steps: [
        { ordinal: 1, name: "before" },
        { ordinal: 2, name: "approval", state: "succeeded" },
        { ordinal: 3, name: "after", attempt: 2 },
      ],
      events: [{ consumed_by: 2 }, { consumed_by: null }],
    });
  });
});
