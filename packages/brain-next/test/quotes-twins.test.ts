// A memory's quote against its source's current version (quotes.ts;
// GRA-1915, the threat model is on the issue), held to two rules after
// every event of generated sequences:
//
// - The twin rule: a reader's answers about a source equal those of a
//   store without the versions of it they may not read (their twin: the
//   same events, those versions left out), and a reader who may not read
//   the source's current version reads nothing of it.
// - The oracle: out is computed from scratch, a memory being out when it
//   rests on a version before its source's current one and the current
//   text holds no run of words equal to its quote, ended at the later of
//   when it was learned and the current version's add. Twins built from
//   the same code can't see a bug that hits both sides alike (a late add
//   left unjudged: see the last case); the oracle can.
//
// `endedAt` is compared by what it names: the memory's own learning, or
// the add of which event's version. Each version's text is unique: a
// text repeated after a narrowed version is a new version in the store
// but the current one again in its twin (sources.ts `madeBefore` compares
// with the current version alone), so its out memories end at the repeat
// in one and earlier in the other: main's own channel, named in quotes.ts,
// and kept out of these sequences.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import {
  apply,
  generator,
  learnedOrder,
  oracle,
  run,
  series,
  shared,
  sideOf,
  surfaces,
  unique,
} from "./quote-twins.ts";
import type { Event } from "./quote-twins.ts";

describe("out memories against twins and the oracle, three groups", () => {
  it("answers every subset of three groups as its twin and the oracle on every surface after every event, late adds on any version, erasures held part-way and ticks among them", async () => {
    const groups = [unique("ga"), unique("gb"), unique("gc")];
    const differ: string[] = [];
    let count = 0;
    // 4242, 99 and 7 failed the round-2 rule of the queued re-check, 1009
    // and 271828 its round-4 reviewer's three-group sequences.
    for (const seed of [4242, 99, 7, 1009, 271_828]) {
      const random = generator(seed);
      for (let index = 0; index < 5; index += 1) {
        count += 1;
        // oxlint-disable-next-line no-await-in-loop -- one case at a time
        const found = await run(groups, series(random), {
          every: true,
          checkAt: "each",
        });
        differ.push(...found);
      }
    }

    expect({ count, differ }).toStrictEqual({ count: 25, differ: [] });
  }, 300_000);

  it("answers the paid review's case as the twins and the oracle: a late add on the first version while another group's version is current, then the first group's again", async () => {
    const differ: string[] = [];
    for (const line of [false, true]) {
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      const found = await run(
        [unique("ga"), unique("gb")],
        [
          { kind: "version", group: 0, line: true },
          { kind: "version", group: 0, line: false },
          { kind: "version", group: 1, line: true },
          { kind: "late", on: 0 },
          { kind: "version", group: 0, line },
        ],
        { every: true, checkAt: "each" }
      );
      differ.push(...found);
    }

    expect(differ).toStrictEqual([]);
  }, 60_000);

  it("finds by the oracle a late add left unjudged on both sides alike, which the twins can't see", async () => {
    const groups = [unique("ga")];
    const events: Event[] = [
      { kind: "version", group: 0, line: true },
      { kind: "version", group: 0, line: false },
      { kind: "late", on: 0 },
    ];
    const real = sideOf();
    const twin = sideOf();
    for (const [at, event] of events.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one event at a time
      await apply(real, at, event, "all", groups);
      // oxlint-disable-next-line no-await-in-loop -- one event at a time
      await apply(twin, at, event, "all", groups);
    }
    // The mutant: a late add's judgment undone on both sides alike.
    await runInDurableObject(shared(), (_instance, state) => {
      state.storage.sql.exec(
        `DELETE FROM memory_outs WHERE memory IN (
          SELECT row FROM memories WHERE id IN (SELECT value FROM json_each(?))
        )`,
        JSON.stringify([real.memories.get(2)?.id, twin.memories.get(2)?.id])
      );
    });
    const reader = { person: unique("p"), groups };
    const got = await surfaces(real, events.length, reader, false);
    const want = await surfaces(twin, events.length, reader, false);

    expect({
      twinSees: JSON.stringify(got) !== JSON.stringify(want),
      oracleSees:
        JSON.stringify(got.states) !==
        JSON.stringify(oracle(real, events.length, [0], learnedOrder(real))),
    }).toStrictEqual({ twinSees: false, oracleSees: true });
  });
});
