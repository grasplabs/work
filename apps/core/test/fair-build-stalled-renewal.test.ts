import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { holding, renewedForMs } from "../src/build-admission.ts";
import type { BuildLease } from "../src/build-admission.ts";
import { admit, anApp, jobOf, policyWith } from "./fair-build-admission.ts";

// Fair admission of the client's build jobs (fair-build-admission.test.ts):
// a step whose lease renewals hang, which waits out a whole lease, in a file
// of its own so it runs beside the others.

describe("fair build admission", { timeout: 60_000 }, () => {
  afterEach(async () => {
    policyWith({});
    await env.DB.batch([
      env.DB.prepare("DELETE FROM build_leases"),
      env.DB.prepare("DELETE FROM build_admission_queue"),
    ]);
  });

  it(
    "stops a step's build once a renewal hangs past its lease's end",
    { timeout: 120_000 },
    async () => {
      const job = jobOf(anApp());
      const lease = await admit(job);
      if (!("lease" in lease)) {
        throw new Error("Not admitted");
      }
      // The database never answers its renewals.
      const stalled: BuildLease = {
        ...lease.lease,
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
        settled: await lease.lease.held(),
      }).toStrictEqual({
        stopped: "The build job's step lost its lease",
        byItsEnd: true,
        settled: false,
      });
    }
  );
});
