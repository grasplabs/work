// Runs that live through process death: plain workerd on disk-backed
// storage, killed with SIGKILL at each durable commit and started again on
// the same directory, and runs that sleep or wait for an event through it
// with no process alive. Every wait polls with a deadline; the journal each
// test reads back is what recovery had to go on.
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

import { Outside, until } from "./outside.ts";
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

/** Each effect of the run, as label and attempt, in the order received. */
const timeline = (id: string): [string, number][] =>
  outside.of(id).map((effect) => [effect.label, effect.attempt]);

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
