import { describe, expect, it } from "vite-plus/test";

import { brainReportSchema } from "../src/brain-report.ts";

/** The steps' part of the report, as the admin reads it. */
const { stepsFailed } = brainReportSchema.shape;

const failed = { at: "2026-11-12T09:55:00.000Z", reason: "failed" } as const;

describe("the steps of a Brain report", () => {
  it("reads the steps a core on an older release reports, though it lacks a step this release has", () => {
    expect(
      stepsFailed.safeParse({
        ledger: null,
        erase: null,
        sweep: null,
        repack: null,
        reindex: null,
        embedding: failed,
      })
    ).toStrictEqual({
      success: true,
      data: {
        ledger: null,
        erase: null,
        sweep: null,
        repack: null,
        reindex: null,
        embedding: failed,
      },
    });
  });

  it("reads the steps a core on a newer release reports, and leaves out a step this release doesn't know", () => {
    expect(
      stepsFailed.safeParse({
        ledger: null,
        erase: null,
        sweep: null,
        repack: null,
        reindex: null,
        quotes: null,
        later: failed,
        embedding: failed,
      })
    ).toStrictEqual({
      success: true,
      data: {
        ledger: null,
        erase: null,
        sweep: null,
        repack: null,
        reindex: null,
        quotes: null,
        embedding: failed,
      },
    });
  });
});

/** The parts of the report a core of another release may send otherwise. */
const { words, ledger, recall } = brainReportSchema.shape;
const { replay, byReason } = ledger.shape;
const { ways, withoutMeaning } = recall.shape;

const way = { recalls: 4, failed: 0 };

describe("a Brain report from a core a release apart", () => {
  it("reads recalls without meaning from an older core lacking a reason, and a newer one's without the reason it adds", () => {
    expect({
      older: withoutMeaning.safeParse({ timed_out: 3, failed: 0, refused: 1 }),
      newer: withoutMeaning.safeParse({
        timed_out: 3,
        failed: 0,
        refused: 1,
        unusable: 0,
        later: 5,
      }),
    }).toStrictEqual({
      older: {
        success: true,
        data: { timed_out: 3, failed: 0, refused: 1 },
      },
      newer: {
        success: true,
        data: { timed_out: 3, failed: 0, refused: 1, unusable: 0 },
      },
    });
  });

  it("reads erasures by reason from an older core lacking a reason, and a newer one's without the reason it adds", () => {
    expect({
      older: byReason.safeParse({ deleted: 3, retention: 0, person_erased: 0 }),
      newer: byReason.safeParse({
        deleted: 3,
        retention: 0,
        person_erased: 0,
        withdrawn: 1,
        later: 2,
      }),
    }).toStrictEqual({
      older: {
        success: true,
        data: { deleted: 3, retention: 0, person_erased: 0 },
      },
      newer: {
        success: true,
        data: { deleted: 3, retention: 0, person_erased: 0, withdrawn: 1 },
      },
    });
  });

  it("reads recall by way from an older core lacking a way, and a newer one's without the way it adds", () => {
    expect({
      older: ways.safeParse({ words: way, meaning: way }),
      newer: ways.safeParse({
        words: way,
        exact: way,
        entities: way,
        meaning: way,
        later: way,
      }),
    }).toStrictEqual({
      older: { success: true, data: { words: way, meaning: way } },
      newer: {
        success: true,
        data: { words: way, exact: way, entities: way, meaning: way },
      },
    });
  });

  it("reads a newer core's own name for why a step failed, how its words stand and how its ledger does, as it sends it", () => {
    const throttled = { at: failed.at, reason: "throttled" };

    expect({
      step: stepsFailed.safeParse({ embedding: throttled }),
      words: words.safeParse("compacting"),
      replay: replay.safeParse("verifying"),
    }).toStrictEqual({
      step: { success: true, data: { embedding: throttled } },
      words: { success: true, data: "compacting" },
      replay: { success: true, data: "verifying" },
    });
  });
});
