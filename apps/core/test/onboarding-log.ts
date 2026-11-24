import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { onboardingStore } from "../src/onboarding/store.ts";

// The onboarding's own log, as its store keeps it: what happened, who did
// it (`staff:<email>`, `person:<id>`, `interviewee`, or Grasp itself),
// whom it is about, and whom it names besides. Nothing serves it outside
// the store, so the tests read its table.

/** One row of the log. */
export interface LogRow {
  what: string;
  by: string;
  about: string | null;
  named: string | null;
}

/** The log's rows whose `what` is `prefix` or starts with `prefix.`, the oldest first. */
export const onboardingLog = async (
  prefix: string,
  store: ReturnType<typeof onboardingStore> = onboardingStore(env)
): Promise<LogRow[]> =>
  await runInDurableObject(store, (_instance, state) =>
    state.storage.sql
      .exec<{
        what: string;
        by: string;
        about: string | null;
        named: string | null;
      }>(
        "SELECT what, by, about, named FROM events WHERE what = ? OR substr(what, 1, ?) = ? ORDER BY seq",
        prefix,
        prefix.length + 1,
        `${prefix}.`
      )
      .toArray()
      .map(({ what, by, about, named }): LogRow => ({ what, by, about, named }))
  );
