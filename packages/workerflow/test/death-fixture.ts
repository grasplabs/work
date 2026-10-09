// The Worker the process-death tests serve on plain workerd
// (test/process): a run object with a short lease, two definitions whose
// effects go to the outside world over HTTP, and a fetch handler that is
// the standalone caller. Nothing of Grasp: no users, Apps, connect or
// permissions.
import { Workflow } from "../src/binding.ts";
import type {
  DefinitionIdentity,
  WorkflowDefinition,
  WorkflowRollbackContext,
  WorkflowStepContext,
  WorkflowStepRollbackOptions,
} from "../src/contracts.ts";
import { namedError } from "../src/errors.ts";
import { runObjectName } from "../src/identity.ts";
import { WorkflowRun } from "../src/run.ts";
import type { DeleteOutcome, StartCommand, StartOutcome } from "../src/run.ts";

interface FixtureEnv {
  RUNS: DurableObjectNamespace<Runs>;
  /** The outside world: the test's own HTTP server. */
  EFFECTS: Fetcher;
}

/**
 * Runs whose ID starts with this tell the outside world after their start
 * committed and before its answer leaves, so a test can kill workerd in
 * that window.
 */
const reportCommitPrefix = "report-commit-";

/**
 * Runs whose ID starts with this tell the outside world after their
 * deletion committed and before its answer leaves.
 */
const reportDeletePrefix = "report-delete-";

/** Grasp's 30 days, the default retention the fixture keeps. */
const maxFixtureRetentionMs = 30 * 24 * 60 * 60 * 1000;

/** Short, so recovery after a kill takes about a second, not a minute. */
const testLeaseMs = 1000;

/**
 * A tombstone's horizon: long enough for a test to kill and restart
 * within it, short enough to wait out.
 */
const testTombstoneMs = 5000;

/**
 * Long enough for a test to see the run asleep and kill or evict it, short
 * enough to wait out; a run's params can ask for another (`nap`, in ms).
 */
const napMs = 3000;

/** The `stuck` step's timeout: the kill comes within milliseconds. */
const stuckTimeoutMs = 5000;

const effect = async (
  env: FixtureEnv,
  run: string,
  label: string,
  context: WorkflowStepContext
): Promise<string> => {
  const response = await env.EFFECTS.fetch("http://effects/effect", {
    method: "POST",
    body: JSON.stringify({
      run,
      label,
      key: context.idempotencyKey,
      attempt: context.attempt,
    }),
  });
  return await response.text();
};

/**
 * A rollback's effect, undoing `label`'s, under the rollback's own key and
 * attempt, as `undo-<label>`.
 */
const undoing = (
  env: FixtureEnv,
  run: string,
  label: string
): WorkflowStepRollbackOptions => ({
  rollback: async (context: WorkflowRollbackContext) => {
    await env.EFFECTS.fetch("http://effects/effect", {
      method: "POST",
      body: JSON.stringify({
        run,
        label: `undo-${label}`,
        key: context.idempotencyKey,
        attempt: context.attempt,
      }),
    });
  },
});

/**
 * A stream of bytes from the outside world: the test can withhold the rest
 * of it after the first part, so the step is mid-upload when it kills.
 */
const download = async (
  env: FixtureEnv,
  run: string,
  context: WorkflowStepContext
): Promise<ReadableStream<Uint8Array> | null> => {
  const response = await env.EFFECTS.fetch("http://effects/stream", {
    method: "POST",
    body: JSON.stringify({
      run,
      label: "export",
      key: context.idempotencyKey,
      attempt: context.attempt,
    }),
  });
  return response.body;
};

const hex = (digest: ArrayBuffer): string =>
  Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

const declinedCard = (): Error =>
  namedError("PaymentError", "The card was declined");

const definitionsFor = (
  env: FixtureEnv
): Record<string, WorkflowDefinition> => ({
  orders: {
    run: async (event, step) => {
      const charge = await step.do(
        "charge",
        async (context) =>
          await effect(env, event.instanceId, "charge", context)
      );
      const ship = await step.do(
        "ship",
        async (context) => await effect(env, event.instanceId, "ship", context)
      );
      return { charge, ship };
    },
  },
  // A stream from outside, then a step that reads back what the first
  // returned and reports its hash outside.
  export: {
    run: async (event, step) => {
      const body = await step.do(
        "export",
        async (context) => await download(env, event.instanceId, context)
      );
      return await step.do("digest", async (context) => {
        const bytes = new Uint8Array(await new Response(body).arrayBuffer());
        const digest = {
          sha256: hex(await crypto.subtle.digest("SHA-256", bytes)),
          length: bytes.byteLength,
        };
        await effect(env, event.instanceId, "digest", context);
        return digest;
      });
    },
  },
  declined: {
    run: async (event, step) => {
      let declined: string | undefined;
      try {
        // No retry: the failure is the point, and it is the step's at once.
        const once = { retries: { limit: 0, delay: 0 } };
        await step.do("charge", once, async (context) => {
          await effect(env, event.instanceId, "charge", context);
          throw declinedCard();
        });
      } catch (error) {
        declined =
          error instanceof Error ? `${error.name}: ${error.message}` : "?";
      }
      const notified = await step.do(
        "notify",
        async (context) =>
          await effect(env, event.instanceId, "notify", context)
      );
      return { declined, notified };
    },
  },
  // A step, a sleep of a few seconds, another step.
  napper: {
    run: async (event, step) => {
      const before = await step.do(
        "before",
        async (context) =>
          await effect(env, event.instanceId, "before", context)
      );
      const nap: unknown =
        typeof event.payload === "object" &&
        event.payload !== null &&
        "nap" in event.payload
          ? event.payload.nap
          : undefined;
      await step.sleep("nap", typeof nap === "number" ? nap : napMs);
      const after = await step.do(
        "after",
        async (context) => await effect(env, event.instanceId, "after", context)
      );
      return { before, after };
    },
  },
  // A step whose first attempt fails, and whose retry comes a few seconds
  // later (or as the params' `delay` says, in ms).
  flaky: {
    run: async (event, step) => {
      const delay: unknown =
        typeof event.payload === "object" &&
        event.payload !== null &&
        "delay" in event.payload
          ? event.payload.delay
          : undefined;
      return await step.do(
        "flaky",
        {
          retries: {
            limit: 1,
            delay: typeof delay === "number" ? delay : napMs,
            backoff: "constant",
          },
        },
        async (context) => {
          const receipt = await effect(env, event.instanceId, "flaky", context);
          if (context.attempt === 1) {
            throw namedError("FlakyError", "attempt 1 failed");
          }
          return receipt;
        }
      );
    },
  },
  // A step with one retry, a second's backoff and a timeout long enough
  // for a test to kill the process while an attempt is out, well before
  // its deadline.
  stuck: {
    run: async (event, step) =>
      await step.do(
        "stuck",
        {
          retries: { limit: 1, delay: 1000, backoff: "constant" },
          timeout: stuckTimeoutMs,
        },
        async (context) => await effect(env, event.instanceId, "stuck", context)
      ),
  },
  // A step with the params' retry limit and a minute's timeout, so a test
  // can kill the process while each attempt is out, well before its
  // deadline.
  "cut-off": {
    run: async (event, step) => {
      const limit: unknown =
        typeof event.payload === "object" &&
        event.payload !== null &&
        "limit" in event.payload
          ? event.payload.limit
          : undefined;
      return await step.do(
        "cut",
        {
          retries: {
            limit: typeof limit === "number" ? limit : 0,
            delay: 1000,
            backoff: "constant",
          },
          timeout: "1 minute",
        },
        async (context) => await effect(env, event.instanceId, "cut", context)
      );
    },
  },
  // Two steps with rollbacks, then a third that fails, uncaught, after its
  // effect: the run rolls the three back, latest first.
  compensated: {
    run: async (event, step) => {
      const once = { retries: { limit: 0, delay: 0 } };
      const charge = await step.do(
        "charge",
        async (context) =>
          await effect(env, event.instanceId, "charge", context),
        undoing(env, event.instanceId, "charge")
      );
      const reserve = await step.do(
        "reserve",
        async (context) =>
          await effect(env, event.instanceId, "reserve", context),
        undoing(env, event.instanceId, "reserve")
      );
      await step.do(
        "ship",
        once,
        async (context) => {
          await effect(env, event.instanceId, "ship", context);
          throw namedError("ShippingError", "No courier came");
        },
        undoing(env, event.instanceId, "ship")
      );
      return { charge, reserve };
    },
  },
  // A call outside any step (which the test can withhold, at any replay
  // too: a replay can't get the rollback back before it), a step with a
  // rollback, then a step that fails, uncaught.
  gated: {
    run: async (event, step) => {
      await env.EFFECTS.fetch("http://effects/gate", {
        method: "POST",
        body: JSON.stringify({ run: event.instanceId }),
      });
      await step.do(
        "first",
        async (context) =>
          await effect(env, event.instanceId, "first", context),
        undoing(env, event.instanceId, "first")
      );
      await step.do("fail", { retries: { limit: 0, delay: 0 } }, () => {
        throw namedError("ShippingError", "No courier came");
      });
    },
  },
  // A step, a wait for an "approved" event, another step.
  approval: {
    run: async (event, step) => {
      await step.do(
        "before",
        async (context) =>
          await effect(env, event.instanceId, "before", context)
      );
      const approved = await step.waitForEvent("approval", {
        type: "approved",
        timeout: "1 minute",
      });
      const after = await step.do(
        "after",
        async (context) => await effect(env, event.instanceId, "after", context)
      );
      return { approved: approved.payload, after };
    },
  },
});

export class Runs extends WorkflowRun<FixtureEnv> {
  protected override readonly leaseMs = testLeaseMs;
  protected override readonly tombstoneMs = testTombstoneMs;

  protected definition({
    definition,
  }: DefinitionIdentity): WorkflowDefinition | undefined {
    return definitionsFor(this.env)[definition];
  }

  override async start(command: StartCommand): Promise<StartOutcome> {
    const outcome = await super.start(command);
    if (command.instanceId.startsWith(reportCommitPrefix)) {
      await this.env.EFFECTS.fetch("http://effects/committed", {
        method: "POST",
        body: JSON.stringify({ run: command.instanceId }),
      });
    }
    return outcome;
  }

  override async deleteRun(): Promise<DeleteOutcome> {
    const instanceId = this.#instanceId();
    const outcome = await super.deleteRun();
    if (instanceId?.startsWith(reportDeletePrefix) === true) {
      await this.env.EFFECTS.fetch("http://effects/deleted", {
        method: "POST",
        body: JSON.stringify({ run: instanceId }),
      });
    }
    return outcome;
  }

  #instanceId(): string | undefined {
    try {
      return this.journal()?.run.instance_id;
    } catch {
      return undefined;
    }
  }

  /** Test-only: the tables the object holds, the host's own left out. */
  tables(): string[] {
    return this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
      )
      .toArray()
      .map((table) => table.name);
  }

  /** Test-only: the stream chunks storage holds, by step and attempt. */
  chunks(): Record<string, SqlStorageValue>[] {
    return this.ctx.storage.sql
      .exec(
        "SELECT ordinal, attempt, COUNT(*) AS chunks, SUM(LENGTH(bytes)) AS length FROM stream_chunks GROUP BY ordinal, attempt ORDER BY ordinal, attempt"
      )
      .toArray();
  }

  /** Test-only: resets the object as an eviction does; storage stays. */
  evict(): void {
    this.ctx.abort("evicted by the test");
  }
}

const json = (value: unknown, status = 200): Response =>
  Response.json(value ?? null, { status });

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface StartBody {
  definition: string;
  id: string;
  key?: string;
  params?: unknown;
  /** Tell the outside world first, so a test can kill before the start. */
  announce?: boolean;
  /** The run's own retention, in milliseconds after it completes. */
  retentionMs?: number;
}

const start = async (env: FixtureEnv, body: StartBody): Promise<Response> => {
  if (body.announce === true) {
    await env.EFFECTS.fetch("http://effects/announce", {
      method: "POST",
      body: JSON.stringify({ run: body.id }),
    });
  }
  // Limits from a millisecond, so a test can see a purge come due.
  const workflow = new Workflow(env.RUNS, body.definition, {
    retentionLimits: { minMs: 1, maxMs: maxFixtureRetentionMs },
  });
  const retention =
    body.retentionMs === undefined
      ? undefined
      : { successRetention: body.retentionMs };
  try {
    if (body.key === undefined) {
      await workflow.create({ id: body.id, params: body.params, retention });
      return json({ created: true });
    }
    const { created } = await workflow.admit({
      id: body.id,
      key: body.key,
      params: body.params,
      retention,
    });
    return json({ created });
  } catch (error) {
    return json({ error: errorText(error) }, 409);
  }
};

interface EventBody {
  definition: string;
  id: string;
  type: string;
  payload?: unknown;
  key?: string;
}

const sendEvent = async (
  env: FixtureEnv,
  body: EventBody
): Promise<Response> => {
  try {
    const instance = await new Workflow(env.RUNS, body.definition).get(body.id);
    const event = { type: body.type, payload: body.payload };
    if (body.key === undefined) {
      await instance.sendEvent(event);
      return json({ accepted: true });
    }
    return json(await instance.deliverEvent({ ...event, key: body.key }));
  } catch (error) {
    return json({ error: errorText(error) }, 409);
  }
};

export default {
  fetch: async (request: Request, env: FixtureEnv): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/ready") {
      // Answers without touching any run object.
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/start") {
      // The test harness sends this shape.
      return await start(env, await request.json<StartBody>());
    }
    if (url.pathname === "/event") {
      // The test harness sends this shape.
      return await sendEvent(env, await request.json<EventBody>());
    }
    const definition = url.searchParams.get("definition") ?? "";
    const id = url.searchParams.get("id") ?? "";
    const stub = env.RUNS.get(
      env.RUNS.idFromName(runObjectName(definition, id))
    );
    switch (url.pathname) {
      case "/status": {
        try {
          const instance = await new Workflow(env.RUNS, definition).get(id);
          return json(await instance.status());
        } catch (error) {
          return json({ error: errorText(error) }, 404);
        }
      }
      case "/chunks": {
        return json(await stub.chunks());
      }
      case "/output": {
        const output = await stub.stepOutput({
          name: url.searchParams.get("name") ?? "",
          count: 1,
        });
        if (output?.kind !== "stream") {
          return json(output);
        }
        return new Response(output.stream, {
          headers: {
            "x-length": String(output.length),
            "x-sha256": output.sha256,
            "x-encoding": output.encoding,
          },
        });
      }
      case "/journal": {
        return json(await stub.journal());
      }
      case "/tables": {
        return json(await stub.tables());
      }
      case "/delete": {
        try {
          const result = await new Workflow(env.RUNS, definition).deleteBatch([
            id,
          ]);
          return json(result);
        } catch (error) {
          return json({ error: errorText(error) }, 409);
        }
      }
      case "/evict": {
        try {
          await stub.evict();
        } catch {
          // The reset breaks this very call.
        }
        return json({ evicted: true });
      }
      default: {
        return new Response(null, { status: 404 });
      }
    }
  },
};
