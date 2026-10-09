// Runs that live through process death: plain workerd on disk-backed
// storage, killed with SIGKILL at each durable commit and started again on
// the same directory, and runs that sleep or wait for an event through it
// with no process alive. Every wait polls with a deadline; the journal each
// test reads back is what recovery had to go on.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vite-plus/test";

import { Outside, streamed, until } from "./outside.ts";
import { bundleFixture, Workerd } from "./workerd.ts";

const bundleDirectory = mkdtempSync(path.join(tmpdir(), "workerflow-bundle-"));
let fixture: string;
const outside = new Outside();
let effectsPort: number;
let workerd: Workerd;

const journalOf = async (definition: string, id: string): Promise<unknown> => {
  const { body } = await workerd.request(
    `/journal?definition=${definition}&id=${id}`
  );
  return body;
};

const statusOf = async (
  definition: string,
  id: string
): Promise<{ status: number; body: unknown }> =>
  await workerd.request(`/status?definition=${definition}&id=${id}`);

const hasEnded = (body: unknown): boolean =>
  typeof body === "object" &&
  body !== null &&
  "status" in body &&
  (body.status === "complete" || body.status === "errored");

const ended = async (definition: string, id: string): Promise<unknown> =>
  await until(`run ${id} to end`, async () => {
    const { body } = await statusOf(definition, id);
    return hasEnded(body) ? body : undefined;
  });

const startOf = (
  definition: string,
  id: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  definition,
  id,
  key: `start-${id}`,
  params: { order: id },
  ...extra,
});

/** Well past a lapsed lease: the fixture's lease is a second. */
const leaseMargin = 2000;

/** When the journal says the current activation's lease runs out. */
const leaseOf = (journal: unknown): number => {
  const run =
    typeof journal === "object" && journal !== null && "run" in journal
      ? journal.run
      : undefined;
  const lease =
    typeof run === "object" && run !== null && "lease_until" in run
      ? run.lease_until
      : undefined;
  if (typeof lease !== "number") {
    throw new TypeError("the journal has no lease");
  }
  return lease;
};

interface StepView {
  name: string;
  state: string;
  deadline: number | null;
}

const isStepView = (value: unknown): value is StepView =>
  typeof value === "object" &&
  value !== null &&
  "name" in value &&
  typeof value.name === "string" &&
  "state" in value &&
  typeof value.state === "string" &&
  "deadline" in value;

/** The journal's steps, as far as these tests read them. */
const stepsOf = (journal: unknown): StepView[] =>
  typeof journal === "object" &&
  journal !== null &&
  "steps" in journal &&
  Array.isArray(journal.steps)
    ? journal.steps.filter((step) => isStepView(step))
    : [];

const runStatusIn = (journal: unknown): unknown =>
  typeof journal === "object" &&
  journal !== null &&
  "run" in journal &&
  typeof journal.run === "object" &&
  journal.run !== null &&
  "status" in journal.run
    ? journal.run.status
    : undefined;

/**
 * Waits until the run has suspended at `step`, with no activation alive,
 * and returns the deadline its journal holds.
 */
const asleepAt = async (
  definition: string,
  id: string,
  step: string
): Promise<number> =>
  await until(`run ${id} to wait at ${step}`, async () => {
    const journal = await journalOf(definition, id);
    const { deadline, state } =
      stepsOf(journal).find((row) => row.name === step) ?? {};
    return runStatusIn(journal) === "waiting" &&
      state === "waiting" &&
      typeof deadline === "number"
      ? deadline
      : undefined;
  });

/**
 * Waits until the run has suspended on the retry of its first step, with
 * no activation alive, and returns when the journal says it is due.
 */
const retryDueAt = async (definition: string, id: string): Promise<number> =>
  await until(`run ${id} to wait for a retry`, async () => {
    const journal = await journalOf(definition, id);
    const attempts: unknown[] =
      typeof journal === "object" &&
      journal !== null &&
      "attempts" in journal &&
      Array.isArray(journal.attempts)
        ? journal.attempts
        : [];
    const [first] = attempts;
    const retryAt =
      typeof first === "object" && first !== null && "retry_at" in first
        ? first.retry_at
        : undefined;
    return runStatusIn(journal) === "waiting" && typeof retryAt === "number"
      ? retryAt
      : undefined;
  });

interface AttemptView {
  attempt: number;
  deadline: number;
  started_at: number;
  ended: string | null;
  retry_at: number | null;
}

const isAttemptView = (value: unknown): value is AttemptView =>
  typeof value === "object" &&
  value !== null &&
  "attempt" in value &&
  "deadline" in value &&
  typeof value.deadline === "number" &&
  "started_at" in value &&
  "ended" in value &&
  "retry_at" in value;

/** The journal's attempts, as far as these tests read them. */
const attemptsOf = (journal: unknown): AttemptView[] =>
  typeof journal === "object" &&
  journal !== null &&
  "attempts" in journal &&
  Array.isArray(journal.attempts)
    ? journal.attempts.filter((attempt) => isAttemptView(attempt))
    : [];

/** Waits until the clock is past `time`, with no process needed. */
const pastTime = async (time: number): Promise<void> => {
  await until(`the clock to pass ${time}`, () =>
    Date.now() > time ? true : undefined
  );
};

/** Each effect of the run, as label and attempt, in the order received. */
const timeline = (id: string): [string, number][] =>
  outside.of(id).map((effect) => [effect.label, effect.attempt]);

const sha256Of = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const keysOf = (id: string, label: string): Set<string> =>
  new Set(outside.of(id, label).map((effect) => effect.key));

describe("a run on disk-backed workerd", () => {
  beforeAll(async () => {
    fixture = bundleFixture(bundleDirectory);
    effectsPort = await outside.listen();
  });

  beforeEach(async () => {
    workerd = await Workerd.create(fixture, effectsPort);
    await workerd.start();
  });

  afterEach(async () => {
    await workerd.dispose();
  });

  afterAll(async () => {
    try {
      await outside.close();
    } finally {
      rmSync(bundleDirectory, { recursive: true, force: true });
    }
  });

  it("resumes rolling back after the process dies mid-rollback: no step runs again, nor a rollback that succeeded", async () => {
    const id = "mid-rollback";
    const undoReserveHeld = outside.hold(id, "undo-reserve", 1);
    await workerd.request("/start", startOf("compensated", id));
    // Killed while the second rollback is out, after the first's commit.
    await undoReserveHeld;
    const cutOff = await journalOf("compensated", id);
    await workerd.kill();
    await workerd.start();

    const status = await ended("compensated", id);

    expect({ status, cutOff }).toMatchObject({
      status: {
        status: "errored",
        error: { name: "ShippingError", message: "No courier came" },
        rollback: { status: "complete" },
      },
      cutOff: {
        run: { status: "rollingBack" },
        steps: [
          { type: "do", name: "charge", state: "succeeded" },
          { type: "do", name: "reserve", state: "succeeded" },
          { type: "do", name: "ship", state: "failed" },
          { type: "rollback", name: "ship", state: "succeeded" },
          { type: "rollback", name: "reserve", state: "running" },
        ],
      },
    });
    // Each forward effect once; the rollback cut off went out again under
    // its one key, which isn't its step's; the others once each.
    expect(timeline(id)).toStrictEqual([
      ["charge", 1],
      ["reserve", 1],
      ["ship", 1],
      ["undo-ship", 1],
      ["undo-reserve", 1],
      ["undo-reserve", 2],
      ["undo-charge", 1],
    ]);
    expect(keysOf(id, "undo-reserve").size).toBe(1);
    expect(keysOf(id, "undo-reserve")).not.toStrictEqual(keysOf(id, "reserve"));
  });

  it("counts a replay the process died in, so replays cut off can't go on for ever", async () => {
    const id = "killed-replay";
    const replaysOf = async (): Promise<unknown> => {
      const journal = await journalOf("gated", id);
      return typeof journal === "object" &&
        journal !== null &&
        "run" in journal &&
        typeof journal.run === "object" &&
        journal.run !== null &&
        "rollback_replays" in journal.run
        ? journal.run.rollback_replays
        : undefined;
    };
    const forward = outside.hold(id, "gate");
    await workerd.request("/start", startOf("gated", id));
    await forward;
    // The replay's call outside any step is withheld next: the run fails,
    // rolls back, and its replay waits there.
    const replay = outside.hold(id, "gate");
    outside.release(id, "gate");
    await replay;
    const counted = await replaysOf();
    await workerd.kill();

    const again = outside.hold(id, "gate");
    await workerd.start();
    await again;
    const recounted = await replaysOf();
    // The killed replay's answer goes to no one; the live one's is let go.
    outside.release(id, "gate");
    outside.release(id, "gate");
    const status = await ended("gated", id);

    expect({ counted, recounted }).toStrictEqual({ counted: 1, recounted: 2 });
    expect(status).toMatchObject({
      status: "errored",
      rollback: { status: "complete" },
    });
    expect(timeline(id)).toStrictEqual([
      ["first", 1],
      ["undo-first", 1],
    ]);
  });

  it("doesn't run a completed step again after the process dies; the step cut off mid-effect runs again under its key", async () => {
    const id = "after-a-step-commit";
    const shipHeld = outside.hold(id, "ship", 1);
    const started = await workerd.request("/start", startOf("orders", id));
    await shipHeld;
    // Killed after charge's commit and before ship's, as the journal says.
    const cutOff = await journalOf("orders", id);
    await workerd.kill();
    await workerd.start();

    // The run resumes with no request reaching it: its alarm brings it back.
    await until("ship to go out again", () =>
      outside.of(id, "ship").find((effect) => effect.attempt === 2)
    );
    const status = await ended("orders", id);

    const [charge, , ship] = outside.of(id);
    expect({ started, cutOff }).toMatchObject({
      started: { status: 200, body: { created: true } },
      cutOff: {
        activations: [{ generation: 1, ended: null }],
        steps: [
          { name: "charge", state: "succeeded", attempt: 1 },
          { name: "ship", state: "running", attempt: 1 },
        ],
      },
    });
    expect(timeline(id)).toStrictEqual([
      ["charge", 1],
      ["ship", 1],
      ["ship", 2],
    ]);
    expect(keysOf(id, "ship").size).toBe(1);
    // Replay returned charge's original receipt without calling it again.
    expect(status).toStrictEqual({
      status: "complete",
      output: { charge: charge?.receipt, ship: ship?.receipt },
    });
    await expect(journalOf("orders", id)).resolves.toMatchObject({
      activations: [
        { generation: 1, ended: null },
        { generation: 2, ended: "settled" },
      ],
      attempts: [
        { ordinal: 1, attempt: 1, generation: 1, ended: "succeeded" },
        { ordinal: 2, attempt: 1, generation: 1, ended: null },
        { ordinal: 2, attempt: 2, generation: 2, ended: "succeeded" },
      ],
    });
  });

  it("throws a journaled step error again after process death without running the step", async () => {
    const id = "after-a-failed-step";
    const notifyHeld = outside.hold(id, "notify", 1);
    await workerd.request("/start", startOf("declined", id));
    await notifyHeld;
    await workerd.restart();

    const status = await ended("declined", id);

    expect(timeline(id)).toStrictEqual([
      ["charge", 1],
      ["notify", 1],
      ["notify", 2],
    ]);
    expect(status).toStrictEqual({
      status: "complete",
      output: {
        declined: "PaymentError: The card was declined",
        notified: outside.of(id, "notify")[1]?.receipt,
      },
    });
    await expect(journalOf("declined", id)).resolves.toMatchObject({
      steps: [
        { name: "charge", state: "failed", attempt: 1 },
        { name: "notify", state: "succeeded", attempt: 2 },
      ],
    });
  });

  it("has no run when the process dies before the start reaches the run object; the start delivered again creates it once", async () => {
    const id = "before-the-start-arrives";
    const announced = outside.hold(id, "announce");
    const lost = workerd
      .request("/start", startOf("orders", id, { announce: true }))
      .catch(() => "lost");
    await announced;
    await workerd.kill();
    const answer = await lost;
    await workerd.start();
    const afterRestart = {
      status: await statusOf("orders", id),
      journal: await journalOf("orders", id),
    };

    const again = await workerd.request("/start", startOf("orders", id));
    await ended("orders", id);

    expect(answer).toBe("lost");
    expect(afterRestart).toMatchObject({
      status: { status: 404 },
      journal: null,
    });
    expect(again).toStrictEqual({ status: 200, body: { created: true } });
    expect(timeline(id)).toStrictEqual([
      ["charge", 1],
      ["ship", 1],
    ]);
  });

  it("keeps the run when the process dies after the start commits and before its answer; the start delivered again finds it", async () => {
    const id = "report-commit-before-the-answer";
    const committed = outside.hold(id, "committed");
    const lost = workerd
      .request("/start", startOf("orders", id))
      .catch(() => "lost");
    await committed;
    await workerd.kill();
    const answer = await lost;
    await workerd.start();

    const again = await workerd.request("/start", startOf("orders", id));
    const status = await ended("orders", id);

    // One run: every effect went out under the keys of one run ID.
    const runIds = new Set(
      outside.of(id).map((effect) => effect.key.split(":")[0])
    );
    expect({ answer, again, status }).toMatchObject({
      answer: "lost",
      again: { status: 200, body: { created: false } },
      status: { status: "complete" },
    });
    expect(runIds.size).toBe(1);
    await expect(journalOf("orders", id)).resolves.toMatchObject({
      steps: [
        { name: "charge", state: "succeeded" },
        { name: "ship", state: "succeeded" },
      ],
    });
  });

  it("keeps a deletion the process dies after: the run stays gone mid-step, and its start delivered again creates nothing", async () => {
    const id = "report-delete-mid-step";
    const chargeHeld = outside.hold(id, "charge", 1);
    await workerd.request("/start", startOf("orders", id));
    await chargeHeld;
    // Killed once the deletion committed, before its answer left.
    const deleted = outside.hold(id, "deleted");
    const lost = workerd
      .request(`/delete?definition=orders&id=${id}`, {})
      .catch(() => "lost");
    await deleted;
    await workerd.kill();
    const answer = await lost;
    await workerd.start();
    const afterRestart = {
      status: await statusOf("orders", id),
      journal: await journalOf("orders", id),
    };

    // The start delivered again finds its tombstone; a plain create under
    // the ID is another run, whose alarm would be any old one's too.
    const again = await workerd.request("/start", startOf("orders", id));
    const create = await workerd.request(
      "/start",
      startOf("orders", id, { key: undefined })
    );
    await ended("orders", id);

    expect({ answer, afterRestart, again, create }).toMatchObject({
      answer: "lost",
      afterRestart: { status: { status: 404 }, journal: null },
      again: { status: 200, body: { created: false } },
      create: { status: 200, body: { created: true } },
    });
    // The deleted run's charge went out once, and nothing after it: the
    // new run's steps are its own, under another run's keys.
    const [first, second] = outside.of(id, "charge");
    expect(timeline(id)).toStrictEqual([
      ["charge", 1],
      ["charge", 1],
      ["ship", 1],
    ]);
    expect(first?.key).not.toBe(second?.key);
  });

  it("expires a tombstone after its horizon though the process died in between: the same start then creates a run", async () => {
    const id = "tombstone-across-death";
    await workerd.request("/start", startOf("orders", id));
    await ended("orders", id);
    const deleted = await workerd.request(
      `/delete?definition=orders&id=${id}`,
      {}
    );
    const within = await workerd.request("/start", startOf("orders", id));
    // Killed with the expiry still to come: only the alarm the deletion
    // set, stored with the tombstone, can bring it.
    await workerd.kill();
    await workerd.start();

    // Its alarm drops it, with no request: the object empties.
    const tablesAfterDeath = await workerd.request(
      `/tables?definition=orders&id=${id}`
    );
    await until("the tombstone to expire", async () => {
      const { body } = await workerd.request(
        `/tables?definition=orders&id=${id}`
      );
      return Array.isArray(body) && body.length === 0 ? true : undefined;
    });
    const after = await workerd.request("/start", startOf("orders", id));
    await ended("orders", id);

    expect({ deleted, within, tablesAfterDeath }).toMatchObject({
      deleted: { status: 200, body: { deleted: [{ id }], errors: [] } },
      within: { status: 200, body: { created: false } },
      tablesAfterDeath: { body: ["tombstones"] },
    });
    expect(after).toStrictEqual({ status: 200, body: { created: true } });
    // Two runs, one after the other, under keys of their own.
    expect(timeline(id)).toStrictEqual([
      ["charge", 1],
      ["ship", 1],
      ["charge", 1],
      ["ship", 1],
    ]);
    expect(keysOf(id, "charge").size).toBe(2);
  });

  it("purges an ended run its retention after its end though the process died in between, tombstone kept", async () => {
    const id = "purged-after-death";
    const retentionMs = 2000;
    await workerd.request("/start", startOf("orders", id, { retentionMs }));
    await ended("orders", id);
    const journal = await journalOf("orders", id);
    // Killed with the purge still to come: only its alarm, stored with the
    // run, can bring it.
    await workerd.kill();
    await workerd.start();

    await until("the run to be purged", async () => {
      const { status } = await statusOf("orders", id);
      return status === 404 ? true : undefined;
    });
    const again = await workerd.request(
      "/start",
      startOf("orders", id, { retentionMs })
    );

    expect(journal).toMatchObject({
      run: { status: "complete", success_retention_ms: retentionMs },
    });
    expect(again).toStrictEqual({ status: 200, body: { created: false } });
    await expect(journalOf("orders", id)).resolves.toBeNull();
    expect(timeline(id)).toStrictEqual([
      ["charge", 1],
      ["ship", 1],
    ]);
  });

  it("still runs the run, once, when the process dies after the start commits; the start delivered again finds it", async () => {
    const id = "after-the-start-commit";
    const chargeHeld = outside.hold(id, "charge", 1);
    await workerd.request("/start", startOf("orders", id));
    await chargeHeld;
    await workerd.restart();

    // Delivered again under its key: the same run, not a second one. A
    // plain create of the same ID collides.
    const again = await workerd.request("/start", startOf("orders", id));
    const create = await workerd.request(
      "/start",
      startOf("orders", id, { key: undefined })
    );
    await ended("orders", id);

    expect({ again, create: create.status }).toStrictEqual({
      again: { status: 200, body: { created: false } },
      create: 409,
    });
    expect(JSON.stringify(create.body)).toMatch(/instance\.already_exists/u);
    expect(timeline(id)).toStrictEqual([
      ["charge", 1],
      ["charge", 2],
      ["ship", 1],
    ]);
    expect(keysOf(id, "charge").size).toBe(1);
    await expect(journalOf("orders", id)).resolves.toMatchObject({
      activations: [
        { generation: 1, ended: null },
        { generation: 2, ended: "settled" },
      ],
    });
  });

  it("recovers an object evicted mid-step from its journal, with no request reaching it", async () => {
    const id = "evicted-mid-step";
    const shipHeld = outside.hold(id, "ship", 1);
    await workerd.request("/start", startOf("orders", id));
    await shipHeld;

    await workerd.request(`/evict?definition=orders&id=${id}`, {});
    await until("ship to go out again", () =>
      outside.of(id, "ship").find((effect) => effect.attempt === 2)
    );
    const status = await ended("orders", id);

    expect(status).toMatchObject({ status: "complete" });
    expect(timeline(id)).toStrictEqual([
      ["charge", 1],
      ["ship", 1],
      ["ship", 2],
    ]);
    await expect(journalOf("orders", id)).resolves.toMatchObject({
      steps: [
        { name: "charge", state: "succeeded", attempt: 1 },
        { name: "ship", state: "succeeded", attempt: 2 },
      ],
    });
  });

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
