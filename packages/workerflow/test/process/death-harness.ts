import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach } from "vite-plus/test";

import { Outside, until } from "./outside.ts";
import { bundleFixture, Workerd } from "./workerd.ts";

// What death*.test.ts share: workerd on disk, a fresh one for each test
// (`onDisk`), the outside its runs reach, and how they read a run back.

const bundleDirectory = mkdtempSync(path.join(tmpdir(), "workerflow-bundle-"));
export const outside = new Outside();
let fixture: string;
let effectsPort: number;
let current: Workerd | undefined;

/** The workerd of the test that runs now. */
const now = (): Workerd => {
  if (current === undefined) {
    throw new Error("No workerd runs outside a test.");
  }
  return current;
};

/**
 * The workerd of whichever test runs: `onDisk` starts a fresh one before
 * each test and disposes of it after, and the tests and these helpers
 * reach it through this.
 */
export const workerd = {
  get url(): string {
    return now().url;
  },
  request: async (...args: Parameters<Workerd["request"]>) =>
    await now().request(...args),
  bytes: async (...args: Parameters<Workerd["bytes"]>) =>
    await now().bytes(...args),
  start: async (): Promise<void> => {
    await now().start();
  },
  kill: async (): Promise<void> => {
    await now().kill();
  },
  restart: async (): Promise<void> => {
    await now().restart();
  },
  redeploy: async (deploy: string): Promise<void> => {
    await now().redeploy(deploy);
  },
  dispose: async (): Promise<void> => {
    await now().dispose();
  },
};

/**
 * Each test of the describe this is called in runs on a workerd of its
 * own on disk; the fixture is bundled once, and the outside listens, for
 * them all.
 */
export const onDisk = (): void => {
  beforeAll(async () => {
    fixture = bundleFixture(bundleDirectory);
    effectsPort = await outside.listen();
  });

  beforeEach(async () => {
    outside.reset();
    current = Workerd.create(fixture, effectsPort);
    await current.start();
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
};

export const journalOf = async (
  definition: string,
  id: string
): Promise<unknown> => {
  const { body } = await workerd.request(
    `/journal?definition=${definition}&id=${id}`
  );
  return body;
};

export const statusOf = async (
  definition: string,
  id: string
): Promise<{ status: number; body: unknown }> =>
  await workerd.request(`/status?definition=${definition}&id=${id}`);

export const hasEnded = (body: unknown): boolean =>
  typeof body === "object" &&
  body !== null &&
  "status" in body &&
  (body.status === "complete" || body.status === "errored");

export const ended = async (definition: string, id: string): Promise<unknown> =>
  await until(`run ${id} to end`, async () => {
    const { body } = await statusOf(definition, id);
    return hasEnded(body) ? body : undefined;
  });

export const startOf = (
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
export const leaseMargin = 2000;

/** When the journal says the current activation's lease runs out. */
export const leaseOf = (journal: unknown): number => {
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

export interface StepView {
  name: string;
  state: string;
  deadline: number | null;
}

export const isStepView = (value: unknown): value is StepView =>
  typeof value === "object" &&
  value !== null &&
  "name" in value &&
  typeof value.name === "string" &&
  "state" in value &&
  typeof value.state === "string" &&
  "deadline" in value;

/** The journal's steps, as far as these tests read them. */
export const stepsOf = (journal: unknown): StepView[] =>
  typeof journal === "object" &&
  journal !== null &&
  "steps" in journal &&
  Array.isArray(journal.steps)
    ? journal.steps.filter((step) => isStepView(step))
    : [];

export const runStatusIn = (journal: unknown): unknown =>
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
export const asleepAt = async (
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
export const retryDueAt = async (
  definition: string,
  id: string
): Promise<number> =>
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

export interface AttemptView {
  attempt: number;
  deadline: number;
  started_at: number;
  ended: string | null;
  retry_at: number | null;
}

export const isAttemptView = (value: unknown): value is AttemptView =>
  typeof value === "object" &&
  value !== null &&
  "attempt" in value &&
  "deadline" in value &&
  typeof value.deadline === "number" &&
  "started_at" in value &&
  "ended" in value &&
  "retry_at" in value;

/** The journal's attempts, as far as these tests read them. */
export const attemptsOf = (journal: unknown): AttemptView[] =>
  typeof journal === "object" &&
  journal !== null &&
  "attempts" in journal &&
  Array.isArray(journal.attempts)
    ? journal.attempts.filter((attempt) => isAttemptView(attempt))
    : [];

/** Waits until the clock is past `time`, with no process needed. */
export const pastTime = async (time: number): Promise<void> => {
  await until(`the clock to pass ${time}`, () =>
    Date.now() > time ? true : undefined
  );
};

/** Each effect of the run, as label and attempt, in the order received. */
export const timeline = (id: string): [string, number][] =>
  outside.of(id).map((effect) => [effect.label, effect.attempt]);

export const sha256Of = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export const keysOf = (id: string, label: string): Set<string> =>
  new Set(outside.of(id, label).map((effect) => effect.key));

/** The message of a run's error, as its status shows it. */
export const errorMessageOf = (status: unknown): string | undefined =>
  typeof status === "object" &&
  status !== null &&
  "error" in status &&
  typeof status.error === "object" &&
  status.error !== null &&
  "message" in status.error &&
  typeof status.error.message === "string"
    ? status.error.message
    : undefined;

/** The run row of a journal, as far as these tests read it. */
export const runOf = (
  journal: unknown
): { status: unknown; notify_at: unknown } | undefined =>
  typeof journal === "object" &&
  journal !== null &&
  "run" in journal &&
  typeof journal.run === "object" &&
  journal.run !== null &&
  "status" in journal.run &&
  "notify_at" in journal.run
    ? { status: journal.run.status, notify_at: journal.run.notify_at }
    : undefined;

/** The host's deliveries for the run, in the order they arrived. */
export const deliveriesOf = (
  id: string,
  label?: string
): { key: string; label: string }[] =>
  outside.notifications.filter(
    (delivery) =>
      delivery.run === id && (label === undefined || delivery.label === label)
  );

/** The sequences a delivery to the host held, from its key. */
export const sequencesIn = (key: string): unknown[] => {
  const parsed: unknown = JSON.parse(key);
  return Array.isArray(parsed)
    ? parsed.map((notification: unknown) =>
        typeof notification === "object" &&
        notification !== null &&
        "sequence" in notification
          ? notification.sequence
          : undefined
      )
    : [];
};

/** An event as a subscriber outside the process reads it. */
export interface ObservedEvent {
  eventId: number;
  type: string;
  stepName?: string;
}

export const isObservedEvent = (value: unknown): value is ObservedEvent =>
  typeof value === "object" &&
  value !== null &&
  "eventId" in value &&
  typeof value.eventId === "number" &&
  "type" in value &&
  typeof value.type === "string";

/**
 * Subscribes to the run's events after `cursor`, handing each to `seen` as
 * it arrives: "done" once the subscription is (the run ended), "cut off"
 * when the connection broke first.
 */
export const observe = async (
  definition: string,
  id: string,
  cursor: number,
  seen: (event: ObservedEvent) => void
): Promise<"done" | "cut off"> => {
  const response = await fetch(
    `${workerd.url}/events?definition=${definition}&id=${id}&cursor=${cursor}`
  );
  if (response.body === null) {
    throw new Error("the events came with no body");
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> =
    response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- the body as it comes
      const { done, value } = await reader.read();
      if (done) {
        return "done";
      }
      buffered += decoder.decode(value, { stream: true });
      for (
        let end = buffered.indexOf("\n");
        end !== -1;
        end = buffered.indexOf("\n")
      ) {
        const event: unknown = JSON.parse(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
        if (!isObservedEvent(event)) {
          throw new TypeError("an event the fixture can't have sent");
        }
        seen(event);
      }
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("an event")) {
      throw error;
    }
    return "cut off";
  }
};
