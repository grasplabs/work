/**
 * An engine of a test's own for the host a run's isolate calls (host.ts):
 * its `step` runs each step's function once, as attempt 1, the attempt's
 * lease holding while the function runs (`leases`) unless the test takes
 * it away, as the engine does once it gives up on the attempt.
 */
import type { HostHooks, RunStep } from "../src/workflows/host.ts";

export const engineOfTest = (): {
  step: RunStep;
  leaseOf: HostHooks["leaseOf"];
  leases: Set<string>;
} => {
  const leases = new Set<string>();
  const step: RunStep = {
    do: async (name, _config, fn) => {
      const key = `key:${name}`;
      leases.add(key);
      try {
        return await fn({ attempt: 1, idempotencyKey: key });
      } finally {
        leases.delete(key);
      }
    },
    sleep: async () => {
      await Promise.resolve();
    },
    sleepUntil: async () => {
      await Promise.resolve();
    },
    waitForEvent: async () => await Promise.reject(new Error("No waits here")),
    waitForMatch: async () => await Promise.reject(new Error("No waits here")),
  };
  const leaseOf: HostHooks["leaseOf"] = (key, attempt) =>
    attempt === 1 && leases.has(key)
      ? { generation: 1, deadline: Date.now() + 60_000 }
      : undefined;
  return { step, leaseOf, leases };
};
