// A step's retries and timeouts through the run object's real boundary: a
// failed attempt's retry is journaled as an absolute time and the run
// suspends until it, an attempt past its timeout is ended and its late
// answer ignored, and a replay that configures a step otherwise ends the
// run. Process death during a retry delay is in test/process.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import type { Journal } from "../src/journal.ts";
import {
  alarmOf,
  deliverAlarm,
  ended,
  journalOf,
  newId,
  runObject,
  until,
  workflow,
} from "./helpers.ts";
import { effectsOf, hold } from "./outside.ts";

/** Waits until the run has suspended on the retry of its step "flaky". */
const retryingOn = async (definition: string, id: string): Promise<Journal> =>
  await until(`run ${id} to wait for a retry`, async () => {
    const journal = await journalOf(definition, id);
    const step = journal.steps.find((row) => row.name === "flaky");
    return journal.run.status === "waiting" && step?.state === "retrying"
      ? journal
      : undefined;
  });

/** How long after each attempt ended the next was due. */
const delaysIn = (journal: Journal): (number | null)[] =>
  journal.attempts.map((attempt) =>
    attempt.retry_at === null || attempt.ended_at === null
      ? null
      : attempt.retry_at - attempt.ended_at
  );

/** What the definition's own code did outside any step. */
const witnessed = (id: string): string[] =>
  effectsOf(id)
    .filter((effect) => effect.attempt === 0)
    .map((effect) => effect.label);

const flakyError = (attempt: number): string =>
  JSON.stringify({ name: "FlakyError", message: `attempt ${attempt} failed` });

describe("a step that fails", () => {
  it("retries after Cloudflare's default delay, journaled as an absolute time, with no activation alive meanwhile", async () => {
    const id = newId();
    await workflow("retrying").create({ id, params: { fails: 1 } });

    const journal = await retryingOn("retrying", id);

    const [attempt] = journal.attempts;
    expect(journal).toMatchObject({
      run: { status: "waiting", wake_at: attempt?.retry_at, lease_until: null },
      activations: [{ generation: 1, ended: "suspended" }],
      steps: [{ name: "flaky", state: "retrying", attempt: 1, error: null }],
      attempts: [{ attempt: 1, ended: "failed", error: flakyError(1) }],
    });
    expect(delaysIn(journal)).toStrictEqual([10_000]);
    await expect(alarmOf("retrying", id)).resolves.toBe(attempt?.retry_at);
    expect(effectsOf(id, "flaky")).toHaveLength(1);
  });

  it.each([
    ["constant", [300, 300, 300, null]],
    ["linear", [300, 600, 900, null]],
    ["exponential", [300, 600, 1200, null]],
  ])(
    "waits as its %s backoff says between attempts, each under a new attempt number and the step's one key",
    async (backoff, delays) => {
      const id = newId();
      await workflow("retrying").create({
        id,
        params: {
          fails: 3,
          config: { retries: { limit: 3, delay: 300, backoff } },
        },
      });

      const status = await ended("retrying", id);

      const journal = await journalOf("retrying", id);
      const flaky = effectsOf(id, "flaky");
      expect(status).toMatchObject({
        status: "complete",
        output: { receipt: flaky[3]?.receipt, attempt: 4 },
      });
      expect(delaysIn(journal)).toStrictEqual(delays);
      // No attempt came before the time journaled for it.
      for (const [index, attempt] of journal.attempts.slice(1).entries()) {
        const due = journal.attempts[index]?.retry_at ?? Number.NaN;
        expect(attempt.started_at).toBeGreaterThanOrEqual(due);
      }
      expect(flaky.map((effect) => effect.attempt)).toStrictEqual([1, 2, 3, 4]);
      expect(new Set(flaky.map((effect) => effect.key)).size).toBe(1);
      expect(journal.steps).toMatchObject([
        { name: "flaky", state: "succeeded", attempt: 4 },
      ]);
    }
  );

  it.each([
    [0, 1],
    [2, 3],
  ])(
    "makes no more than its limit of %i retries, and fails with the last attempt's error once they are spent",
    async (limit, attempts) => {
      const id = newId();
      await workflow("retrying").create({
        id,
        params: { fails: 99, config: { retries: { limit, delay: 0 } } },
      });

      const status = await ended("retrying", id);

      const journal = await journalOf("retrying", id);
      expect(status).toStrictEqual({
        status: "complete",
        output: {
          caught: { name: "FlakyError", message: `attempt ${attempts} failed` },
        },
      });
      expect(effectsOf(id, "flaky")).toHaveLength(attempts);
      expect(journal.steps).toMatchObject([
        { state: "failed", attempt: attempts, error: flakyError(attempts) },
      ]);
      expect(journal.attempts.map((attempt) => attempt.ended)).toStrictEqual(
        Array.from({ length: attempts }, () => "failed")
      );
      // Every attempt but the last had a retry due; the last had none.
      expect(delaysIn(journal)).toStrictEqual([
        ...Array.from({ length: attempts - 1 }, () => 0),
        null,
      ]);
    }
  );

  it.each([
    ["a NonRetryableError", "non-retryable", "NonRetryableError"],
    [
      "an error whose message starts with NonRetryableError",
      "prefixed",
      "Error",
    ],
  ])("isn't retried after %s, whatever its limit", async (_, failure, name) => {
    const id = newId();
    await workflow("retrying").create({
      id,
      params: {
        fails: 99,
        failure,
        config: { retries: { limit: 5, delay: 0 } },
      },
    });

    const status = await ended("retrying", id);

    expect(status).toMatchObject({
      status: "complete",
      output: { caught: { name } },
    });
    expect(effectsOf(id, "flaky")).toHaveLength(1);
    await expect(journalOf("retrying", id)).resolves.toMatchObject({
      steps: [{ state: "failed", attempt: 1 }],
      attempts: [{ ended: "failed", retry_at: null }],
    });
  });

  it("doesn't move its retry for an alarm that comes early, or comes twice", async () => {
    const id = newId();
    await workflow("retrying").create({
      id,
      params: { fails: 1, config: { retries: { limit: 1, delay: "1 hour" } } },
    });
    const before = await retryingOn("retrying", id);
    const retryAt = before.attempts[0]?.retry_at;

    await deliverAlarm("retrying", id);
    await deliverAlarm("retrying", id);

    const journal = await journalOf("retrying", id);
    expect(journal).toMatchObject({
      run: { status: "waiting", wake_at: retryAt },
      activations: [
        { ended: "suspended" },
        { ended: "suspended" },
        { ended: "suspended" },
      ],
      steps: [{ state: "retrying", attempt: 1 }],
    });
    expect(journal.attempts).toStrictEqual(before.attempts);
    await expect(alarmOf("retrying", id)).resolves.toBe(retryAt);
    expect(effectsOf(id, "flaky")).toHaveLength(1);
  });

  it("tells its callback its config, defaults filled in as Cloudflare fills them", async () => {
    const plain = newId();
    const configured = newId();
    await workflow("retrying").create({ id: plain });
    await workflow("retrying").create({
      id: configured,
      params: {
        config: { retries: { limit: 1, delay: "2 seconds" }, timeout: 5000 },
      },
    });

    await expect(ended("retrying", plain)).resolves.toMatchObject({
      output: {
        config: {
          retries: { limit: 5, delay: 10_000, backoff: "exponential" },
          timeout: "10 minutes",
        },
      },
    });
    await expect(ended("retrying", configured)).resolves.toMatchObject({
      output: {
        config: {
          retries: { limit: 1, delay: "2 seconds", backoff: "exponential" },
          timeout: 5000,
        },
      },
    });
  });
});

describe("a step's delay function", () => {
  it("is asked with a provisional retry journaled, which an activation that takes over keeps without asking again", async () => {
    const id = newId();
    const asking = hold(id, "delay", 1);
    await workflow("dynamic-delay").create({ id, params: { delay: "hold" } });
    await asking.held;
    const provisional = await journalOf("dynamic-delay", id);

    // Another activation while the function is out: the retry stands.
    await deliverAlarm("dynamic-delay", id);
    const takenOver = await journalOf("dynamic-delay", id);
    // The function answers, too late to count.
    asking.release();
    const after = await until("the answer to be refused", async () => {
      const journal = await journalOf("dynamic-delay", id);
      return journal.activations[0]?.ended === null ? undefined : journal;
    });

    // Fenced at its failure: the attempt is ended, its retry provisional
    // at the default delay until the function says otherwise.
    expect(provisional).toMatchObject({
      steps: [{ state: "retrying", attempt: 1 }],
      attempts: [{ ended: "failed", error: flakyError(1) }],
    });
    expect(delaysIn(provisional)).toStrictEqual([10_000]);
    expect(takenOver).toMatchObject({
      run: { status: "waiting", wake_at: provisional.attempts[0]?.retry_at },
      activations: [{ ended: null }, { ended: "suspended" }],
    });
    // Its answer found the activation that asked taken over: ignored.
    expect({
      activations: after.activations.map((row) => row.ended),
      attempts: after.attempts,
      asked: witnessed(id),
    }).toStrictEqual({
      activations: ["superseded", "suspended"],
      attempts: provisional.attempts,
      asked: ["asked-1-FlakyError", "delay-answered"],
    });
  });

  it("has 5 seconds to answer, and fails the step with a NonRetryableDelayError after that", async () => {
    const id = newId();
    // Never released: the function never answers.
    const asking = hold(id, "delay", 1);
    await workflow("dynamic-delay").create({ id, params: { delay: "hold" } });
    await asking.held;

    const status = await ended("dynamic-delay", id);

    expect(status).toStrictEqual({
      status: "complete",
      output: {
        caught: {
          name: "NonRetryableDelayError",
          message:
            'The delay function for step "flaky-1" did not return within 5 seconds',
        },
      },
    });
    await expect(journalOf("dynamic-delay", id)).resolves.toMatchObject({
      steps: [{ state: "failed" }],
      attempts: [{ ended: "failed", retry_at: null }],
    });
  });

  it("is asked once per failure, and what it said is journaled and never asked again", async () => {
    const id = newId();
    await workflow("dynamic-delay").create({ id, params: { delay: "1 hour" } });
    const before = await retryingOn("dynamic-delay", id);

    await deliverAlarm("dynamic-delay", id);

    const journal = await journalOf("dynamic-delay", id);
    expect(delaysIn(before)).toStrictEqual([60 * 60 * 1000]);
    expect(journal.attempts).toStrictEqual(before.attempts);
    expect(witnessed(id)).toStrictEqual(["asked-1-FlakyError"]);
  });

  it.each([
    ["throws", "throw", "threw an error: no delay today"],
    [
      "says something that isn't a delay",
      "soon",
      'returned an invalid delay value (expected a number of ms or a duration string like "30 seconds")',
    ],
  ])(
    "fails the step at once with a NonRetryableDelayError when it %s",
    async (_, delay, reason) => {
      const id = newId();
      await workflow("dynamic-delay").create({ id, params: { delay } });

      const status = await ended("dynamic-delay", id);

      expect(status).toStrictEqual({
        status: "complete",
        output: {
          caught: {
            name: "NonRetryableDelayError",
            message: `The delay function for step "flaky-1" ${reason}`,
          },
        },
      });
      expect(effectsOf(id, "flaky")).toHaveLength(1);
      // The attempt keeps its own error; the step's is the delay's.
      await expect(journalOf("dynamic-delay", id)).resolves.toMatchObject({
        steps: [{ state: "failed" }],
        attempts: [{ ended: "failed", error: flakyError(1), retry_at: null }],
      });
    }
  );
});

describe("a callback that runs past its timeout without awaiting", () => {
  it("times out, though it answered before any timer could fire", async () => {
    const id = newId();
    await workflow("busy").create({ id });

    const status = await ended("busy", id);

    expect(status).toStrictEqual({
      status: "complete",
      output: {
        caught: {
          name: "WorkflowTimeoutError",
          message: "Execution timed out after 1ms",
        },
      },
    });
    await expect(journalOf("busy", id)).resolves.toMatchObject({
      steps: [{ name: "busy", state: "failed", value: null }],
      attempts: [{ attempt: 1, ended: "timed_out" }],
    });
  });
});

describe("a callback whose attempt has ended", () => {
  it("can't call the step API: nothing it calls is journaled or counted, or answered", async () => {
    const id = newId();
    const lingering = hold(id, "lingering", 1);
    const after = hold(id, "after", 1);
    await workflow("lingers").create({ id });
    await lingering.held;
    // The attempt has timed out and the author has caught that.
    await after.held;

    lingering.release();
    await until("the late callback's calls", () =>
      witnessed(id).includes("called") ? true : undefined
    );
    const afterLateCalls = await journalOf("lingers", id);
    after.release();
    const status = await ended("lingers", id);

    expect(afterLateCalls.steps).toMatchObject([
      { name: "lingering", state: "failed" },
    ]);
    // The author's own "nested" is the first of its name: the late call
    // took no occurrence.
    expect(status).toStrictEqual({
      status: "complete",
      output: {
        caught: {
          name: "WorkflowTimeoutError",
          message: "Execution timed out after 1000ms",
        },
        nested: effectsOf(id, "nested")[0]?.receipt,
      },
    });
    await expect(journalOf("lingers", id)).resolves.toMatchObject({
      steps: [
        { name: "lingering", state: "failed" },
        { name: "nested", occurrence: 1, state: "succeeded" },
      ],
    });
    expect({
      nested: effectsOf(id, "nested").length,
      witnessed: witnessed(id),
    }).toStrictEqual({ nested: 1, witnessed: ["called"] });
  });
});

describe("an attempt that runs past its timeout", () => {
  it("is ended, its late answer is ignored, and the retry runs as a new attempt under the step's key", async () => {
    const id = newId();
    const first = hold(id, "hung", 1);
    // The activation the retry's alarm starts, held before the step.
    const retry = hold(id, "activation", 2);
    await workflow("hung").create({ id });
    await first.held;
    await retry.held;
    const timedOut = await journalOf("hung", id);

    // The first attempt answers now, while the retry is under way.
    first.release();
    await until("the first attempt's late answer", () =>
      witnessed(id).includes("answered-1") ? true : undefined
    );
    const afterLateAnswer = await journalOf("hung", id);
    retry.release();
    const status = await ended("hung", id);

    const hung = effectsOf(id, "hung");
    expect(timedOut).toMatchObject({
      activations: [{ ended: "suspended" }, { ended: null }],
      steps: [{ name: "hung", state: "retrying", attempt: 1, value: null }],
      attempts: [
        {
          attempt: 1,
          ended: "timed_out",
          error: JSON.stringify({
            name: "WorkflowTimeoutError",
            message: "Execution timed out after 1000ms",
          }),
        },
      ],
    });
    // Its answer changed nothing: the attempt stays timed out.
    expect({
      delays: delaysIn(timedOut),
      steps: afterLateAnswer.steps,
      attempts: afterLateAnswer.attempts,
    }).toStrictEqual({
      delays: [1000],
      steps: timedOut.steps,
      attempts: timedOut.attempts,
    });
    expect(status).toStrictEqual({
      status: "complete",
      output: hung[1]?.receipt,
    });
    // A new attempt number, under the step's one key.
    expect({
      attempts: hung.map((effect) => effect.attempt),
      keys: new Set(hung.map((effect) => effect.key)).size,
    }).toStrictEqual({ attempts: [1, 2], keys: 1 });
    await expect(journalOf("hung", id)).resolves.toMatchObject({
      steps: [{ name: "hung", state: "succeeded", attempt: 2 }],
      attempts: [
        { attempt: 1, generation: 1, ended: "timed_out" },
        { attempt: 2, generation: 2, ended: "succeeded" },
      ],
    });
  });
});

describe("a retry beside a step still out", () => {
  it("waits for that step to land before the run suspends, so its effect isn't cut off", async () => {
    const id = newId();
    const steady = hold(id, "steady");
    await workflow("retry-beside").create({ id });
    await steady.held;

    const parked = await until("flaky to wait for its retry", async () => {
      const journal = await journalOf("retry-beside", id);
      const flaky = journal.steps.find((step) => step.name === "flaky");
      return flaky?.state === "retrying" ? journal : undefined;
    });
    steady.release();
    const status = await ended("retry-beside", id);

    expect(parked).toMatchObject({
      run: { status: "running" },
      activations: [{ ended: null }],
    });
    expect(status).toStrictEqual({
      status: "complete",
      output: [
        effectsOf(id, "flaky")[1]?.receipt,
        effectsOf(id, "steady")[0]?.receipt,
      ],
    });
    expect(effectsOf(id, "steady")).toHaveLength(1);
    await expect(journalOf("retry-beside", id)).resolves.toMatchObject({
      activations: [{ ended: "suspended" }, { ended: "settled" }],
    });
  });
});

describe("a replay that configures a step otherwise", () => {
  const first = { retries: { limit: 1, delay: "1 hour" } };

  it.each([
    ["another retry limit", { retries: { limit: 2, delay: "1 hour" } }],
    [
      "another backoff",
      { retries: { limit: 1, delay: "1 hour", backoff: "linear" } },
    ],
    ["another timeout", { ...first, timeout: "5 minutes" }],
  ])(
    "ends the run with a WorkflowReplayMismatchError: %s",
    async (_, later) => {
      const id = newId();
      await workflow("reconfigured").create({ id, params: { first, later } });
      const before = await retryingOn("reconfigured", id);

      await deliverAlarm("reconfigured", id);
      const status = await ended("reconfigured", id);

      expect(status).toMatchObject({
        status: "errored",
        error: { name: "WorkflowReplayMismatchError" },
      });
      // The journal is as the first activation left it, and nothing is left
      // to wake for.
      const after = await journalOf("reconfigured", id);
      expect(after.steps).toStrictEqual(before.steps);
      expect(after.attempts).toStrictEqual(before.attempts);
      await expect(alarmOf("reconfigured", id)).resolves.toBeNull();
      expect(effectsOf(id, "flaky")).toHaveLength(1);
    }
  );

  it.each([
    ["the delay in other units", { retries: { limit: 1, delay: 3_600_000 } }],
    [
      "the default backoff named",
      { retries: { limit: 1, delay: "1 hour", backoff: "exponential" } },
    ],
    ["the default timeout named", { ...first, timeout: "10 minutes" }],
  ])("goes on waiting when it gives the same config: %s", async (_, later) => {
    const id = newId();
    await workflow("reconfigured").create({ id, params: { first, later } });
    const before = await retryingOn("reconfigured", id);

    await deliverAlarm("reconfigured", id);

    await expect(journalOf("reconfigured", id)).resolves.toMatchObject({
      run: { status: "waiting", wake_at: before.attempts[0]?.retry_at },
      activations: [{ ended: "suspended" }, { ended: "suspended" }],
    });
  });
});

describe("a journal write that fails as an attempt fails", () => {
  it("never reaches the author's handlers, and recovery runs the step again", async () => {
    const id = newId();
    const attempt = hold(id, "flaky", 1);
    await workflow("retrying").create({
      id,
      params: { fails: 1, config: { retries: { limit: 1, delay: 0 } } },
    });
    await attempt.held;
    await runInDurableObject(runObject("retrying", id), (_, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fail_retry BEFORE UPDATE OF state ON steps WHEN NEW.state = 'retrying' BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END"
      );
    });

    attempt.release();
    const faulted = await until("the activation to fault", async () => {
      const journal = await journalOf("retrying", id);
      return journal.activations[0]?.ended === "faulted" ? journal : undefined;
    });
    await runInDurableObject(runObject("retrying", id), (_, state) => {
      state.storage.sql.exec("DROP TRIGGER fail_retry");
    });
    // The watchdog's activation, delivered now rather than a lease away.
    await deliverAlarm("retrying", id);
    const status = await ended("retrying", id);

    // The failed write took the attempt's end with it: the attempt was
    // cut off, and the next one goes out at once.
    expect(faulted).toMatchObject({
      run: { status: "running" },
      steps: [{ state: "running", attempt: 1 }],
      attempts: [{ attempt: 1, ended: null }],
    });
    expect(status).toMatchObject({
      status: "complete",
      output: { attempt: 2, receipt: effectsOf(id, "flaky")[1]?.receipt },
    });
  });
});
