// Hand-overs through the work queue (src/handover.ts), driven as core's
// clock drives the shared store: the host puts a source's key on the
// queue, and a tick asks the host to hand it over. Each test's storage is
// its own; the host here is the test's.
import type {
  AskModel,
  Embedders,
  HandOverResult,
  HandOvers,
} from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { workAttemptsMax } from "../src/work.ts";

/** The shared store, where hand-overs are queued. */
const store = () => env.BRAIN_STORE.getByName("brain");

/** The host's model: never asked here. */
const quietAsk: AskModel = async () => {
  await Promise.resolve();
  return { kind: "answer", text: "" };
};

/** No model ships: nothing is embedded. */
const noEmbedders: Embedders = {
  model: null,
  embed: async () => {
    await Promise.resolve();
    return { kind: "unavailable" };
  },
};

/**
 * A host keeping each source it is asked to hand over, failing while
 * `failing`, and saying it added it once it doesn't.
 */
const hostOf = (
  failing = false
): HandOvers & { asked: string[]; failing: boolean } => {
  const asked: string[] = [];
  const host = {
    asked,
    failing,
    handOver: async (source: string): Promise<HandOverResult> => {
      await Promise.resolve();
      host.asked.push(source);
      if (host.failing) {
        throw new Error("The host is out of reach");
      }
      return { kind: "added", version: 1 };
    },
  };
  return host;
};

/** The queue's clock across a test: only forward, as core's clock goes. */
const clock = { at: Date.now() };

/** One tick with `host`, `aheadMs` past the last. */
const tick = async (host: HandOvers, aheadMs = 0): Promise<void> => {
  clock.at = Math.max(clock.at, Date.now()) + aheadMs;
  await store().work({
    ask: quietAsk,
    at: new Date(clock.at),
    embedders: noEmbedders,
    handOvers: host,
  });
};

/** The hand-overs parked before this test: the store is the file's. */
let parkedBefore = new Set<string>();

/** The hand-overs parked now, as keys. */
const parkedNow = async (): Promise<string[]> => {
  const overview = await store().workOverview();
  return overview.parked
    .filter(({ kind }) => kind === "source.handover")
    .map(({ key }) => key);
};

/** The queue's hand-overs, waiting and parked since this test began. */
const queued = async (): Promise<{ waiting: number; parked: string[] }> => {
  const overview = await store().workOverview();
  const parked = await parkedNow();
  return {
    waiting:
      overview.waiting.find(({ kind }) => kind === "source.handover")?.count ??
      0,
    parked: parked.filter((key) => !parkedBefore.has(key)),
  };
};

describe("handing a source over through the queue", () => {
  beforeEach(async () => {
    parkedBefore = new Set(await parkedNow());
  });

  it("asks the host to hand each source over once, however often it was put on before a tick", async () => {
    const host = hostOf();

    await store().handOver({
      items: [
        { source: "upload:a", priority: "conversation" },
        { source: "run:b", priority: "conversation" },
      ],
    });
    await store().handOver({
      items: [{ source: "upload:a", priority: "conversation" }],
    });
    await tick(host);

    expect({
      asked: host.asked.toSorted(),
      queue: await queued(),
    }).toStrictEqual({
      asked: ["run:b", "upload:a"],
      queue: { waiting: 0, parked: [] },
    });
  });

  it("tries a hand-over the host failed again after its backoff, and parks it where staff see it after too many failures", async () => {
    const host = hostOf(true);
    await store().handOver({
      items: [{ source: "upload:late", priority: "conversation" }],
    });

    await tick(host);
    const afterOne = await queued();
    // Each next failure waits twice as long: 1, 2, 4 and 8 minutes.
    for (let attempt = 1; attempt < workAttemptsMax; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after another, past each backoff
      await tick(host, 2 ** attempt * 60_000);
    }

    expect({
      afterOne,
      asked: host.asked.length,
      parked: await queued(),
    }).toStrictEqual({
      afterOne: { waiting: 1, parked: [] },
      asked: workAttemptsMax,
      parked: { waiting: 0, parked: ["upload:late"] },
    });
  });

  it("hands a failed one over once the host answers again, and is done with it", async () => {
    const host = hostOf(true);
    await store().handOver({
      items: [{ source: "run:again", priority: "conversation" }],
    });
    await tick(host);
    host.failing = false;
    await tick(host, 2 * 60_000);

    expect({ asked: host.asked, queue: await queued() }).toStrictEqual({
      asked: ["run:again", "run:again"],
      queue: { waiting: 0, parked: [] },
    });
  });

  it("refuses what isn't a source's key or a class of work, putting nothing on", async () => {
    const refused = async (request: unknown): Promise<string> => {
      try {
        // SAFETY: the store checks what it is given; this hands it what
        // the type rules out, as a caller outside TypeScript could.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        await store().handOver(request as never);
        return "taken";
      } catch {
        return "refused";
      }
    };

    expect({
      empty: await refused({ items: [] }),
      noKey: await refused({
        items: [{ source: "", priority: "conversation" }],
      }),
      unknownClass: await refused({
        items: [{ source: "upload:a", priority: "asked" }],
      }),
      queue: await queued(),
    }).toStrictEqual({
      empty: "refused",
      noKey: "refused",
      unknownClass: "refused",
      queue: { waiting: 0, parked: [] },
    });
  });

  it("refuses hand-overs on a person's own store, putting nothing on its queue", async () => {
    const own = env.BRAIN_STORE.getByName(`person:${crypto.randomUUID()}`);
    let refused = "";
    try {
      await own.handOver({
        items: [{ source: "run:a", priority: "conversation" }],
      });
    } catch (error) {
      refused = error instanceof Error ? error.message : "refused";
    }
    const overview = await own.workOverview();

    expect({
      refused,
      waiting: overview.waiting.length,
      parked: overview.parked.length,
    }).toStrictEqual({
      refused: "The Brain refused it: only the shared store takes this",
      waiting: 0,
      parked: 0,
    });
  });

  it("settles a hand-over the host refused as done, never trying it again, and tries one whose answer isn't one again", async () => {
    const asked: string[] = [];
    const answering = (answer: unknown): HandOvers => ({
      handOver: async (source) => {
        await Promise.resolve();
        asked.push(source);
        // SAFETY: the store checks what the host answers; this hands it
        // what the type rules out, as a host outside TypeScript could.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        return answer as HandOverResult;
      },
    });
    await store().handOver({
      items: [{ source: "run:refused", priority: "conversation" }],
    });
    await tick(answering({ kind: "refused", reason: "too_large" }));
    await tick(
      answering({ kind: "refused", reason: "too_large" }),
      20 * 60_000
    );
    const afterRefused = { asked: [...asked], queue: await queued() };
    asked.length = 0;
    await store().handOver({
      items: [{ source: "run:odd", priority: "conversation" }],
    });
    await tick(answering({ kind: "maybe" }));

    expect({
      afterRefused,
      odd: { asked, queue: await queued() },
    }).toStrictEqual({
      afterRefused: {
        asked: ["run:refused"],
        queue: { waiting: 0, parked: [] },
      },
      odd: { asked: ["run:odd"], queue: { waiting: 1, parked: [] } },
    });
  });
});
