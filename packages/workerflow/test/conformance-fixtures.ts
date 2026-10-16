// The definitions the conformance suite runs on both engines: Workerflow's
// run object and the reference engine (the Workflows engine Wrangler ships,
// on the same workerd). Each is written once, against Workerflow's
// contracts, and handed to each engine unchanged; conformance-worker.ts is
// the import adapter between them. Durations are milliseconds and short:
// the reference sleeps and backs off in real time.
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowStepRollbackOptions,
} from "../src/contracts.ts";
import { NonRetryableError } from "../src/errors.ts";

/**
 * What each run's callbacks noted, by instance ID: how many times an
 * effect ran, and what a rollback was given. Both engines run their
 * callbacks in the test's isolate, so the test reads it directly.
 */
export const observed = new Map<string, unknown[]>();

const note = (instanceId: string, value: unknown): void => {
  const notes = observed.get(instanceId) ?? [];
  notes.push(value);
  observed.set(instanceId, notes);
};

export const notesOf = (instanceId: string): unknown[] =>
  observed.get(instanceId) ?? [];

/** No retry: the step's failure is the step's at once. */
const once = { retries: { limit: 0, delay: 0 } };

/** Two quick retries, 10 ms apart. */
const quick = {
  retries: { limit: 2, delay: 10, backoff: "constant" as const },
};

const errorOf = (error: unknown): { name: string; message: string } =>
  error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "not an error", message: String(error) };

const describedField = (field: unknown): unknown => {
  if (field instanceof Date) {
    return { date: field.getTime() };
  }
  if (field instanceof Uint8Array) {
    return { bytes: [...field] };
  }
  if (field instanceof Map) {
    return { map: [...field.entries()] };
  }
  if (field instanceof Set) {
    return { set: [...field.values()] };
  }
  if (field instanceof RegExp) {
    return { regexp: [field.source, field.flags] };
  }
  if (field instanceof Error) {
    return { error: [field.name, field.message] };
  }
  if (typeof field === "bigint") {
    return { bigint: field.toString() };
  }
  if (typeof field === "number" && Number.isNaN(field)) {
    return { number: "NaN" };
  }
  if (Array.isArray(field)) {
    return {
      array: field.length,
      holes: field.length - Object.keys(field).length,
    };
  }
  return field;
};

/** What a definition can say of a structured value it got back. */
const described = (value: unknown): unknown => {
  if (!(typeof value === "object" && value !== null)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [key, describedField(field)])
  );
};

/** A stream of the bytes "hi". */
const hiStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start: (controller) => {
      controller.enqueue(new Uint8Array([104, 105]));
      controller.close();
    },
  });

const undoing = (
  instanceId: string,
  label: string
): WorkflowStepRollbackOptions => ({
  rollback: (context) => {
    note(instanceId, {
      undo: label,
      output: context.output,
      error: errorOf(context.error),
      // The deprecated name is the point: both engines must give it.
      // oxlint-disable-next-line typescript/no-deprecated
      stepName: context.stepName,
      step: context.ctx.step,
    });
  },
});

/** Records `label` once per time its callback runs. */
const counted = (instanceId: string, label: string) => (): string => {
  note(instanceId, label);
  return label;
};

const failingThrice = async (step: WorkflowStep): Promise<void> => {
  for (const backoff of ["constant", "linear", "exponential"] as const) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- steps run one after another, as a definition writes them
      await step.do(
        backoff,
        { retries: { limit: 3, delay: 10, backoff } },
        () => {
          throw new Error(backoff);
        }
      );
    } catch {
      // Each policy's retries are what the test reads.
    }
  }
};

export const fixtures: Record<string, WorkflowDefinition> = {
  // The event a definition is given, and whether its timestamp is the same
  // after a suspension (a replay, on Workerflow).
  event: {
    run: async (event, step) => {
      const before = await step.do("read", () => event.timestamp.getTime());
      await step.sleep("nap", 20);
      return {
        payload: event.payload,
        keys: Object.keys(event).toSorted(),
        timestampIsDate: event.timestamp instanceof Date,
        stableTimestamp: before === event.timestamp.getTime(),
        instanceId: event.instanceId,
      };
    },
  },
  // `do`'s three forms, a step inside a step, and an author's catch.
  overloads: {
    run: async (event, step) => {
      const bare = await step.do("bare", () => "bare");
      const configured = await step.do("configured", once, () => "configured");
      const withRollback = await step.do(
        "with-rollback",
        () => "with-rollback",
        undoing(event.instanceId, "with-rollback")
      );
      const nested = await step.do(
        "outer",
        async () => await step.do("inner", () => "inner")
      );
      let caught: unknown;
      try {
        await step.do("fails", once, () => {
          throw new RangeError("out of range");
        });
      } catch (error) {
        caught = errorOf(error);
      }
      return { bare, configured, withRollback, nested, caught };
    },
  },
  // A step's context: occurrences of one name, attempts across retries,
  // its resolved config, given and defaulted.
  context: {
    run: async (_event, step) => {
      const first = await step.do("same", (context) => context.step);
      const second = await step.do("same", (context) => context.step);
      const attempts = await step.do("flaky", quick, (context) => {
        if (context.attempt < 3) {
          throw new Error(`attempt ${context.attempt}`);
        }
        return { attempt: context.attempt, config: context.config };
      });
      const defaults = await step.do("defaults", (context) => context.config);
      const keys = await step.do("keys", (context) =>
        Object.keys(context).toSorted()
      );
      return { first, second, attempts, defaults, keys };
    },
  },
  backoffs: {
    run: async (_event, step) => {
      await failingThrice(step);
    },
  },
  "string-delay": {
    run: async (_event, step) => {
      try {
        await step.do(
          "x",
          { retries: { limit: 1, delay: "1 second", backoff: "constant" } },
          () => {
            throw new Error("x");
          }
        );
      } catch {
        // The delay is what the test reads.
      }
    },
  },
  "dynamic-delay": {
    run: async (event, step) =>
      await step.do(
        "x",
        {
          retries: {
            limit: 2,
            delay: ({ ctx }) => {
              note(event.instanceId, ctx.attempt);
              return 10;
            },
          },
        },
        () => {
          throw new Error("dynamic");
        }
      ),
  },
  "spent-retries": {
    run: async (event, step) =>
      await step.do("x", quick, (context) => {
        note(event.instanceId, context.attempt);
        throw new Error(`failed ${context.attempt}`);
      }),
  },
  "slow-step": {
    run: async (_event, step) =>
      await step.do("x", { ...once, timeout: 50 }, async () => {
        await scheduler.wait(500);
        return "late";
      }),
  },
  "zero-timeout": {
    run: async (_event, step) => await step.do("x", { timeout: 0 }, () => 1),
  },
  "non-retryable-caught": {
    run: async (event, step) => {
      try {
        await step.do("x", quick, (context) => {
          note(event.instanceId, context.attempt);
          throw new NonRetryableError("no point");
        });
      } catch (error) {
        return errorOf(error);
      }
      return "not thrown";
    },
  },
  "non-retryable": {
    run: async (event, step) =>
      await step.do("x", quick, (context) => {
        note(event.instanceId, context.attempt);
        throw new NonRetryableError("no point");
      }),
  },
  sleeps: {
    run: async (_event, step) => {
      await step.sleep("number", 20);
      await step.sleep("text", "1 second");
      await step.sleepUntil("date", new Date(Date.now() + 20));
      await step.sleepUntil("time", Date.now() + 20);
      return "slept";
    },
  },
  "past-sleep": {
    run: async (_event, step) => {
      await step.sleepUntil("past", new Date(0));
      return "slept";
    },
  },
  "negative-sleep": {
    run: async (_event, step) => {
      await step.sleep("negative", -5);
      return "slept";
    },
  },
  "parallel-sleeps": {
    run: async (_event, step) => {
      await Promise.all([step.sleep("a", 50), step.sleep("b", 60)]);
      return "slept";
    },
  },
  // Two events sent before either wait was reached.
  buffered: {
    run: async (_event, step) => {
      await step.sleep("let-them-arrive", 300);
      const first = await step.waitForEvent("first", {
        type: "item",
        timeout: 1000,
      });
      const second = await step.waitForEvent("second", {
        type: "item",
        timeout: 1000,
      });
      return {
        payloads: [first.payload, second.payload],
        type: first.type,
        timestampIsDate: first.timestamp instanceof Date,
      };
    },
  },
  "wait-timeout": {
    run: async (_event, step) => {
      try {
        await step.waitForEvent("w", { type: "item", timeout: 50 });
      } catch (error) {
        return errorOf(error);
      }
      return "got one";
    },
  },
  "wait-race": {
    run: async (_event, step) =>
      await Promise.race([
        step.waitForEvent("reply", { type: "reply", timeout: 2000 }),
        step.sleep("give-up", 3000),
      ]),
  },
  "odd-event-type": {
    run: async (_event, step) => {
      try {
        await step.waitForEvent("w", { type: "has space", timeout: 50 });
      } catch (error) {
        return errorOf(error).name;
      }
      return "got one";
    },
  },
  // Every value kind a step returns, described by the definition itself.
  values: {
    run: async (_event, step) =>
      described(
        await step.do("values", () => ({
          date: new Date(5),
          bytes: new Uint8Array([1, 2]),
          map: new Map([[1, "one"]]),
          set: new Set(["s"]),
          regexp: /a+/giu,
          error: new TypeError("kept"),
          bigint: 10n,
          nan: Number.NaN,
          // oxlint-disable-next-line no-sparse-arrays -- a hole is one of the values
          holes: [1, , 3],
          nested: { deep: [{ n: null }] },
          text: "é",
        }))
      ),
  },
  "function-value": {
    run: async (_event, step) =>
      await step.do("value", () => ({ callback: () => 1 })),
  },
  "class-value": {
    run: async (_event, step) =>
      await step.do(
        "value",
        () =>
          new (class Order {
            readonly id = 1;
          })()
      ),
  },
  stream: {
    run: async (_event, step) => {
      const stream = await step.do("stream", () => hiStream());
      await step.sleep("nap", 20);
      return await new Response(stream).text();
    },
  },
  "locked-stream": {
    run: async (_event, step) =>
      await step.do("stream", once, () => {
        const stream = hiStream();
        stream.getReader();
        return stream;
      }),
  },
  "text-stream": {
    run: async (_event, step) =>
      await step.do(
        "stream",
        once,
        () =>
          new ReadableStream({
            start: (controller) => {
              controller.enqueue("text");
              controller.close();
            },
          })
      ),
  },
  "byob-stream": {
    run: async (_event, step) => {
      const stream = await step.do("stream", () => hiStream());
      const reader = stream.getReader({ mode: "byob" });
      const { value } = await reader.read(new Uint8Array(8));
      return value === undefined ? [] : [...value];
    },
  },
  sensitive: {
    run: async (_event, step) =>
      await step.do("secret", { sensitive: "output" }, () => "s3cr3t"),
  },
  throws: {
    run: () => {
      throw new RangeError("bad input");
    },
  },
  // One step, a sleep, a second step: paused in the sleep, it must not
  // run the second until resumed.
  pausable: {
    run: async (event, step) => {
      await step.do("one", counted(event.instanceId, "one"));
      await step.sleep("nap", 300);
      await step.do("two", counted(event.instanceId, "two"));
      return "done";
    },
  },
  // A step, then a wait: restarted from the wait, the step isn't run again.
  gated: {
    run: async (event, step) => {
      await step.do("one", counted(event.instanceId, "one"));
      await step.waitForEvent("go", { type: "go", timeout: 5000 });
      await step.do("two", counted(event.instanceId, "two"));
      return "done";
    },
  },
  compensated: {
    run: async (event, step) => {
      await step.do("a", () => "A", undoing(event.instanceId, "a"));
      await step.do("b", () => "B", undoing(event.instanceId, "b"));
      await step.do("c", () => "C");
      throw new Error("end");
    },
  },
  "compensated-failure": {
    run: async (event, step) => {
      await step.do(
        "a",
        once,
        () => {
          throw new Error("a failed");
        },
        undoing(event.instanceId, "a")
      );
    },
  },
  "failed-rollback": {
    run: async (_event, step) => {
      await step.do("a", () => "A", {
        rollback: () => {
          throw new NonRetryableError("can't undo");
        },
      });
      throw new Error("end");
    },
  },
  "terminated-rollback": {
    run: async (event, step) => {
      await step.do("a", () => "A", undoing(event.instanceId, "a"));
      await step.waitForEvent("w", { type: "never", timeout: 5000 });
      return "never";
    },
  },
  // A rollback that takes a while: its run's status is read meanwhile.
  "slow-rollback": {
    run: async (_event, step) => {
      await step.do("a", () => "A", {
        rollback: async () => {
          await scheduler.wait(400);
        },
      });
      throw new Error("end");
    },
  },
  names: {
    run: async (_event, step) => await step.do("n".repeat(256), () => "kept"),
  },
  "long-name": {
    run: async (_event, step) => await step.do("n".repeat(257), () => "kept"),
  },
  "empty-name": {
    run: async (_event, step) => await step.do("", () => "kept"),
  },
};
