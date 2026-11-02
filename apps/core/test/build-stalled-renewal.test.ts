import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { holding, renewedForMs } from "../src/build-admission.ts";
import type { BuildLease } from "../src/build-admission.ts";
import { aJob, admit, holds, leaseOf } from "./build-slots.ts";

// The limit on build jobs building at once (build-slots.test.ts): a step
// whose lease renewals hang, which waits out a whole lease, in a file of
// its own so it runs beside the others.

describe("build jobs building at once", { timeout: 60_000 }, () => {
  afterEach(async () => {
    await env.DB.prepare("DELETE FROM build_leases").run();
  });

  it(
    "stop a step's build once a renewal hangs past its lease's end",
    { timeout: 120_000 },
    async () => {
      const job = aJob();
      const lease = leaseOf(await admit(job));
      // The database never answers its renewals.
      const stalled: BuildLease = {
        ...lease,
        renew: async () => await Promise.withResolvers<never>().promise,
      };
      const building = Promise.withResolvers<string>();
      const started = Date.now();
      let stopped: string;
      try {
        await holding(stalled, async () => await building.promise);
        stopped = "ran to its end";
      } catch (error) {
        stopped = error instanceof Error ? error.message : String(error);
      }
      building.resolve("built");
      expect({
        stopped,
        byItsEnd: Date.now() - started < renewedForMs + 5000,
        settled: !(await holds(job)),
      }).toStrictEqual({
        stopped: "The build job's step lost its lease",
        byItsEnd: true,
        settled: true,
      });
    }
  );
});
