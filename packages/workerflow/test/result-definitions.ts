// Test definitions whose steps return structured values, byte streams,
// sensitive results and coded errors (results.test.ts).
import { env } from "cloudflare:workers";

import type { WorkflowDefinition } from "../src/contracts.ts";
import { namedError } from "../src/errors.ts";
import { chunkStream, patterned, pieces, sha256 } from "./bytes.ts";
import { checkpoint, effect, witness } from "./outside.ts";

/** The most a step's stream may hold in these tests (the host's limit). */
export const testMaxStreamBytes = 1024 * 1024;

/** How many one-byte chunks "tiny-chunks" streams. */
export const tinyChunks = 262_144;

/** How long the stalled upload's attempt has. */
export const stuckStreamTimeoutMs = 500;

/** The most all of a run's streams may hold in these tests. */
export const testMaxRunStreamBytes = 1200 * 1024;

/** What "slow-stream" sends before it can be held: more than a chunk. */
export const slowStreamFirst = 300 * 1024;
export const slowStreamRest = 100 * 1024;

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};

const sizesOf = (payload: unknown): number[] => {
  const { sizes } = recordOf(payload);
  return Array.isArray(sizes)
    ? sizes.filter((size): size is number => typeof size === "number")
    : [];
};

const kindOf = (payload: unknown): string => {
  const { kind } = recordOf(payload);
  return typeof kind === "string" ? kind : "";
};

/** Reads a stream to its end: its bytes, hash and length. */
const digestOf = async (
  body: unknown
): Promise<{ sha256: string; length: number; fresh: boolean }> => {
  if (!(body instanceof ReadableStream)) {
    throw new TypeError("the step didn't return a stream");
  }
  const fresh = !body.locked;
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  return { sha256: await sha256(bytes), length: bytes.byteLength, fresh };
};

/** Streams a step can't keep, by the name a test asks for. */
const invalidStreams: Record<string, () => unknown> = {
  locked: () => {
    const stream = chunkStream([patterned(10)]);
    stream.getReader();
    return stream;
  },
  "locked-by-a-byob-reader": () => {
    const stream = new ReadableStream({
      type: "bytes",
      start: (controller) => {
        controller.enqueue(patterned(10));
        controller.close();
      },
    });
    stream.getReader({ mode: "byob" });
    return stream;
  },
  "a-string-chunk": () => chunkStream(["text"]),
  "a-data-view-chunk": () => chunkStream([new DataView(new ArrayBuffer(4))]),
  "an-oversized-chunk": () =>
    chunkStream([new Uint8Array(16 * 1024 * 1024 + 1)]),
  // Its cancel is its own code, and never settles: the run still ends.
  "a-cancel-that-never-settles": () =>
    new ReadableStream({
      start: (controller) => {
        controller.enqueue("text");
      },
      cancel: async () => await Promise.withResolvers<never>().promise,
    }),
  // A chunk whose buffer is transferred away after it was handed over.
  "a-detached-chunk": () =>
    new ReadableStream({
      start: (controller) => {
        const buffer = new ArrayBuffer(8);
        controller.enqueue(buffer);
        buffer.transfer();
      },
    }),
  "too-large": () => chunkStream([patterned(testMaxStreamBytes), patterned(1)]),
  "errors-midway": () =>
    new ReadableStream<Uint8Array>({
      start: (controller) => {
        // More than a stored chunk: some of it is written before the error.
        controller.enqueue(patterned(300 * 1024));
      },
      pull: (controller) => {
        controller.error(new Error("the source broke"));
      },
    }),
};

/** Values a step can't keep, by the name a test asks for. */
const unkeepables: Record<string, () => unknown> = {
  url: () => new URL("https://example.com"),
  "rpc-stub": () => env.RUNS.get(env.RUNS.idFromName("elsewhere")),
  "a-function-inside": () => ({ callback: () => "live" }),
};

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : "not an error";
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "not an error";

const graspError = (): Error =>
  namedError(
    "WorkflowError(workflow.invalid_input)",
    "No such input",
    "workflow.invalid_input"
  );

/** An error with a host's own code, which isn't kept. */
const hostError = (): Error => {
  const error = new Error("socket hang up");
  Object.defineProperty(error, "code", { value: "ECONNRESET" });
  return error;
};

const caught = (error: unknown): Record<string, unknown> =>
  error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        code: Reflect.get(error, "code"),
      }
    : { thrown: String(error) };

/** A step that fails once and for all: no retries, none waited for. */
const noRetries = { retries: { limit: 0, delay: 0 } };

/** An error whose message carries what a sensitive step must not show. */
const secretError = (id: string): Error => new Error(`token=secret-${id}`);

/** A config whose sensitivity is a getter of its class, not its own. */
class SensitiveConfig {
  // oxlint-disable-next-line class-methods-use-this, typescript/class-literal-property-style -- a getter on the prototype, not an own field, is the point
  get sensitive(): "output" {
    return "output";
  }
}

export const resultDefinitions: Record<string, WorkflowDefinition> = {
  // A step the test can hold, then a step whose value can't be kept, in
  // the author's own try, catch and finally.
  "unkeepable-after": {
    run: async (event, step) => {
      await step.do(
        "before",
        async (context) => await effect(event.instanceId, "before", context)
      );
      try {
        await step.do("link", () => {
          witness(event.instanceId, "linked");
          return new URL("https://example.com");
        });
        return "kept";
      } catch {
        witness(event.instanceId, "caught");
      } finally {
        witness(event.instanceId, "finally");
      }
      return "caught";
    },
  },
  // A stream, a step the test can hold, then a step that reads the stream
  // back, all in one activation unless the test intervenes.
  "replay-read": {
    run: async (event, step) => {
      const body = await step.do("export", () =>
        chunkStream([patterned(600 * 1024)])
      );
      await step.do(
        "pause",
        async (context) => await effect(event.instanceId, "pause", context)
      );
      return await step.do("digest", async (context) => {
        try {
          return await digestOf(body);
        } catch (error) {
          witness(event.instanceId, "read-failed");
          throw error;
        } finally {
          witness(event.instanceId, `read-attempt-${context.attempt}`);
        }
      });
    },
  },
  // A step called with a config the payload names, built here: what a
  // payload can't carry (a getter that throws, an inherited setting).
  "odd-config": {
    run: async (event, step) => {
      const kind = kindOf(event.payload);
      const config: unknown =
        kind === "throws"
          ? {
              get sensitive(): never {
                throw new Error("unreadable");
              },
            }
          : Object.create({ verbose: true });
      const result: unknown = await Reflect.apply(step.do, step, [
        "configured",
        config,
        () => "ran",
      ]);
      return result;
    },
  },
  // A step that starts reading a stream result and cancels the read while
  // its first chunk is still being checked, then a step after it.
  "cancel-read": {
    run: async (event, step) => {
      const body = await step.do("export", () =>
        chunkStream([patterned(300 * 1024)])
      );
      const cancelled = await step.do("peek", async () => {
        if (!(body instanceof ReadableStream)) {
          throw new TypeError("the step didn't return a stream");
        }
        const reader = body.getReader();
        // The read starts the pull, which reads chunk 0 and awaits its
        // digest; the cancel comes in the same turn, before that digest
        // can settle, whatever the timing.
        const pending = reader.read();
        await reader.cancel("enough");
        const { done } = await pending;
        return done;
      });
      const after = await step.do(
        "after",
        async (context) => await effect(event.instanceId, "after", context)
      );
      return { cancelled, after };
    },
  },
  // A sensitive step configured through a class's getter.
  "class-config": {
    run: async (event, step) =>
      await step.do(
        "token",
        new SensitiveConfig(),
        () => `secret-${event.instanceId}`
      ),
  },
  // A step the test can hold, then a stream, then a step that reads back
  // what the stream's step returned.
  "stream-after": {
    run: async (event, step) => {
      await step.do(
        "before",
        async (context) => await effect(event.instanceId, "before", context)
      );
      const body = await step.do("export", () =>
        chunkStream([patterned(300 * 1024)])
      );
      return await digestOf(body);
    },
  },
  // Two streams that together hold more than a run's streams may.
  "two-streams": {
    run: async (_event, step) => {
      await step.do("first", () => chunkStream([patterned(700 * 1024)]));
      await step.do("second", () => chunkStream([patterned(700 * 1024)]));
      return "both kept";
    },
  },
  // A step sensitive in the first activation and not in the next: the
  // replay strays from what the journal holds.
  "sensitive-toggle": {
    run: async (event, step) => {
      const reached = await checkpoint(event.instanceId, "config");
      const config = reached === 1 ? { sensitive: "output" as const } : {};
      await step.do("token", config, () => "value");
      return await step.do(
        "use",
        async (context) => await effect(event.instanceId, "use", context)
      );
    },
  },
  // A sensitive step that throws an error carrying its secret.
  "secret-throws": {
    run: async (event, step) => {
      const { caught: catches } = recordOf(event.payload);
      try {
        await step.do("token", { sensitive: "output", ...noRetries }, () => {
          throw secretError(event.instanceId);
        });
        return "unreachable";
      } catch (error) {
        if (catches !== true) {
          throw error;
        }
        return { name: errorName(error), message: errorMessage(error) };
      }
    },
  },
  // A stream of 262,144 one-byte chunks, read back.
  "tiny-chunks": {
    run: async (_event, step) => {
      const body = await step.do("export", () =>
        chunkStream(
          Array.from({ length: tinyChunks }, (_, index) =>
            Uint8Array.of(index % 256)
          )
        )
      );
      return await digestOf(body);
    },
  },
  // A step whose error says it can't be retried the first time its name is
  // read, and that it can the next.
  "fickle-error": {
    run: async (_event, step) => {
      try {
        await step.do("flaky", { retries: { limit: 2, delay: 0 } }, () => {
          let reads = 0;
          const error = new Error("changes its mind");
          Object.defineProperty(error, "name", {
            get: () => {
              reads += 1;
              return reads === 1 ? "NonRetryableError" : "Error";
            },
          });
          throw error;
        });
        return "unreachable";
      } catch (error) {
        return errorName(error);
      }
    },
  },
  // A sensitive step that fails every attempt with its secret, retried once.
  "secret-retries": {
    run: async (event, step) =>
      await step.do(
        "token",
        { sensitive: "output", retries: { limit: 1, delay: 0 } },
        () => {
          throw secretError(event.instanceId);
        }
      ),
  },
  // A stream whose upload stalls after its first part, past its attempt's
  // timeout; the definition catches what the step fails with, and with
  // `linger` in its params waits after that for the test to let it end.
  "stuck-stream": {
    run: async (event, step) => {
      const { linger } = recordOf(event.payload);
      try {
        await step.do(
          "export",
          { timeout: stuckStreamTimeoutMs, retries: { limit: 0, delay: 0 } },
          () =>
            new ReadableStream<Uint8Array>({
              start: (controller) => {
                controller.enqueue(patterned(300 * 1024));
              },
              pull: async (controller) => {
                await checkpoint(event.instanceId, "stuck");
                controller.enqueue(patterned(300 * 1024, 1));
                controller.close();
              },
            })
        );
        return "kept";
      } catch (error) {
        if (linger === true) {
          await checkpoint(event.instanceId, "after");
        }
        return errorName(error);
      }
    },
  },
  // A sensitive step whose stream fails with its secret in the reason.
  "secret-invalid-stream": {
    run: async (event, step) => {
      await step.do(
        "file",
        { sensitive: "output" },
        () =>
          new ReadableStream({
            pull: (controller) => {
              controller.error(secretError(event.instanceId));
            },
          })
      );
      return "unreachable";
    },
  },
  // A stream of the payload's `sizes`, then a step that reads back what the
  // first step returned.
  streamed: {
    run: async (event, step) => {
      const sizes = sizesOf(event.payload);
      const content = patterned(
        sizes.reduce((sum, size) => sum + size, 0),
        sizes.length
      );
      const body = await step.do("export", async (context) => {
        await effect(event.instanceId, "export", context);
        return chunkStream(pieces(content, sizes));
      });
      return await step.do("digest", async (context) => {
        const digest = await digestOf(body);
        await effect(event.instanceId, "digest", context);
        return digest;
      });
    },
  },
  // A stream whose rest the test can hold after its first part: the step
  // is mid-upload while the test acts. Then its bytes are read back.
  "slow-stream": {
    run: async (event, step) => {
      const body = await step.do("export", (context) => {
        let sent = false;
        return new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(patterned(slowStreamFirst));
          },
          pull: async (controller) => {
            if (sent) {
              return;
            }
            sent = true;
            await effect(event.instanceId, "export", context);
            controller.enqueue(patterned(slowStreamRest, 1));
            controller.close();
          },
        });
      });
      return await digestOf(body);
    },
  },
  // A byte stream (`type: "bytes"`), not locked: kept like any other.
  "byte-stream": {
    run: async (_event, step) => {
      const body = await step.do(
        "export",
        () =>
          new ReadableStream({
            type: "bytes",
            start: (controller) => {
              controller.enqueue(patterned(1000));
              controller.close();
            },
          })
      );
      return await digestOf(body);
    },
  },
  // A stream the step can't keep; the definition tries to catch it.
  "invalid-stream": {
    run: async (event, step) => {
      const make = invalidStreams[kindOf(event.payload)];
      try {
        await step.do("export", () => make?.());
        return "kept";
      } catch {
        witness(event.instanceId, "caught");
      } finally {
        witness(event.instanceId, "finally");
      }
      return "caught";
    },
  },
  // A value the step can't keep; the definition tries to catch it.
  unkeepable: {
    run: async (event, step) => {
      const make = unkeepables[kindOf(event.payload)];
      try {
        await step.do("link", () => make?.());
        return "kept";
      } catch {
        witness(event.instanceId, "caught");
      } finally {
        witness(event.instanceId, "finally");
      }
      return "caught";
    },
  },
  // A sensitive step, a plain one, then one the test can hold.
  secret: {
    run: async (event, step) => {
      const token = await step.do(
        "token",
        { sensitive: "output" },
        () => `secret-${event.instanceId}`
      );
      const visible = await step.do("visible", () => "shown to observers");
      await step.do(
        "use",
        async (context) => await effect(event.instanceId, "use", context)
      );
      return { token, visible };
    },
  },
  // A sensitive step whose result is a stream.
  "secret-stream": {
    run: async (_event, step) => {
      const body = await step.do("file", { sensitive: "output" }, () =>
        chunkStream([patterned(100)])
      );
      return await digestOf(body);
    },
  },
  // A step called with the payload's config, as a definition might.
  misconfigured: {
    run: async (event, step) => {
      const { config } = recordOf(event.payload);
      const result: unknown = await Reflect.apply(step.do, step, [
        "configured",
        config,
        () => "ran",
      ]);
      return result;
    },
  },
  // Coded errors from steps, caught by the definition.
  "coded-caught": {
    run: async (_event, step) => {
      const errors: Record<string, unknown>[] = [];
      for (const [name, make] of [
        ["grasp", graspError],
        ["host", hostError],
      ] as const) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- steps run in order
          await step.do(name, noRetries, () => {
            throw make();
          });
        } catch (error) {
          errors.push(caught(error));
        }
      }
      return errors;
    },
  },
  // A coded error from a step the definition doesn't catch.
  "coded-uncaught": {
    run: async (_event, step) =>
      await step.do("lookup", noRetries, () => {
        throw graspError();
      }),
  },
};
