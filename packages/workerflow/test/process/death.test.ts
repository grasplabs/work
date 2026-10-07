// Runs that live through process death: plain workerd on disk-backed
// storage, killed with SIGKILL at each durable commit and started again on
// the same directory. Every wait polls with a deadline; the journal each
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
let outside: Outside;
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

/** Each effect of the run, as label and attempt, in the order received. */
const timeline = (id: string): [string, number][] =>
  outside.of(id).map((effect) => [effect.label, effect.attempt]);

const keysOf = (id: string, label: string): Set<string> =>
  new Set(outside.of(id, label).map((effect) => effect.key));

describe("a run on disk-backed workerd", () => {
  beforeAll(async () => {
    fixture = bundleFixture(bundleDirectory);
    outside = new Outside();
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
    await outside.close();
    rmSync(bundleDirectory, { recursive: true, force: true });
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

  it("has no run when the process dies before the start commits; the start delivered again creates it once", async () => {
    const id = "before-the-start-commit";
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
});
