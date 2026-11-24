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
