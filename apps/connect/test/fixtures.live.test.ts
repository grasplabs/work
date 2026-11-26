/**
 * Records a connector's fixtures (GRA-2328) against its vendor itself:
 * skipped unless the environment names the connector and a credential.
 * Connect's whole call path runs, as for any call (policy, a fresh
 * isolate, the egress adding the credential), and what leaves connect goes
 * on to the vendor and is recorded with its answer, nothing secret or
 * personal kept (test/fixture-recorder.ts).
 *
 * Write the cases first, in the `fixtures.json` beside the connector's
 * entry: the fields that are personal data, and for each case the tool
 * (one that only reads) and its arguments, the argument a paged case pages
 * with (`cursor`), and the kind an error case fails with (`error`).
 * Then, from the repo root, with an account of Grasp's own that holds
 * only made-up data, never a client's, which the run makes you confirm:
 *
 *   RECORD_MADE_UP_DATA=yes \
 *   RECORD_CONNECTOR=<the connector's entry, such as
 *     packages/connectors/acme/src/index.ts> \
 *   RECORD_CREDENTIAL=<its API key, or an access token with its scopes> \
 *   vp test run --project @grasp-os/connect test/fixtures.live.test.ts -u
 *
 * The run writes the file with what it recorded, which connect's build
 * then replays (`-u` lets the run write the file).
 */
import { env } from "cloudflare:workers";
import { describe, expect, inject, it } from "vite-plus/test";
import { z } from "zod";

import { recordFixtures } from "./fixture-recorder.ts";

const live = z.object({ RECORD_CREDENTIAL: z.string().min(1) }).safeParse(env);

/** The internet itself, before any test stands in for it. */
const internet = globalThis.fetch;

describe.runIf(live.success && inject("recording") !== null)(
  "a connector's fixtures, recorded live",
  () => {
    it("records each case against the vendor, and writes them beside the connector", async () => {
      const recording = inject("recording");
      if (recording === null || live.data === undefined) {
        throw new Error("Name the connector and its credential to record");
      }
      const recorded = await recordFixtures(
        recording.name,
        live.data.RECORD_CREDENTIAL,
        recording.plan,
        async (request) => await internet(request)
      );
      await expect(
        `${JSON.stringify(recorded, null, 2)}\n`
      ).toMatchFileSnapshot(recording.file);
    });
  }
);
