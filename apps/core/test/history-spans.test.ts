import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { historyEntries } from "../src/workflows/history.ts";

// A run's history read up to an end (`historyEntries` with `until`), as a
// live list's loaded page of it is: against an engine journal longer than
// one page's reads reach (5 reads of 200 events), which only the engine
// itself (an outside system here, its run object) can hold, and a real
// run of the platform's own can't reach in a test (a run takes at most
// 1,000 steps). The journal stands in for the run object's `history`.

/**
 * A journal of `total` events, as the run object answers its reads; one
 * that `stalls` answers no event however often it says more follow.
 */
const journal = (total: number, stalls = false) => {
  const stub = {
    history: async ({ after, limit }: { after: number; limit: number }) => {
      await Promise.resolve();
      const last = stalls ? after : Math.min(total, after + limit);
      return {
        records: Array.from({ length: Math.max(0, last - after) }, (_, at) => ({
          eventId: after + at + 1,
          at: after + at + 1,
          unreadable: true,
        })),
        more: stalls || last < total,
        steps: [[]],
      };
    },
  };
  const namespace = {
    idFromName: () => "run",
    get: () => stub,
    jurisdiction: () => namespace,
  };
  // SAFETY: the history reader reaches only `idFromName`, `get` and the
  // stub's `history`, which the journal answers as the run object does.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- see SAFETY
  return { ...env, WORKFLOW_RUNS: namespace } as unknown as Env;
};

const telling = { sees: false, taskOf: () => null };

describe("a run's history read up to an end", () => {
  it("says where a span longer than its reads reach stopped, never answering it as whole", async () => {
    const long = await historyEntries(
      journal(5000),
      "run",
      { after: 0, pageSize: 1, until: 4000 },
      telling
    );
    const within = await historyEntries(
      journal(5000),
      "run",
      { after: 0, pageSize: 1, until: 300 },
      telling
    );
    expect({
      stoppedAt: long.stoppedAt,
      entries: long.items.length,
      withinStoppedAt: within.stoppedAt,
      withinEntries: within.items.length,
    }).toStrictEqual({
      stoppedAt: 1000,
      entries: 1000,
      withinStoppedAt: undefined,
      withinEntries: 300,
    });
  });

  it("expires a span whose reads got no further than its start, rather than split it where it began", async () => {
    let code: unknown = "read";
    try {
      await historyEntries(
        journal(5000, true),
        "run",
        { after: 10, pageSize: 1, until: 4000 },
        telling
      );
    } catch (error) {
      code = error instanceof Error && "code" in error ? error.code : error;
    }
    expect(code).toBe("data.cursor_expired");
  });
});
