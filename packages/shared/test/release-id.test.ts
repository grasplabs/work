import { describe, expect, it } from "vite-plus/test";

import {
  compareReleaseIds,
  nextReleaseId,
  releaseIdSchema,
} from "../src/release-id.ts";

const october = new Date("2026-10-29T23:59:59.999Z");

describe("a release's id", () => {
  it("is the publish month's first, YY.MM.1, when the month has none yet", () => {
    expect(nextReleaseId([], october)).toBe("26.10.1");
    expect(nextReleaseId(["26.09.40", "dev-abc"], october)).toBe("26.10.1");
    expect(nextReleaseId([], new Date("2027-01-01T00:00:00.000Z"))).toBe(
      "27.01.1"
    );
  });

  it("counts on from the month's highest N, by number, past any gap", () => {
    expect(nextReleaseId(["26.10.1", "26.10.2"], october)).toBe("26.10.3");
    expect(nextReleaseId(["26.10.9", "26.10.10", "26.10.4"], october)).toBe(
      "26.10.11"
    );
    expect(nextReleaseId(["26.10.1", "26.10.7"], october)).toBe("26.10.8");
  });

  it("goes by the UTC month, whatever the local time", () => {
    expect(
      nextReleaseId(["26.10.5"], new Date("2026-10-31T23:30:00-02:00"))
    ).toBe("26.11.1");
  });

  it("orders by year, month and N as numbers, local builds first", () => {
    expect(
      [
        "26.10.10",
        "26.10.9",
        "dev-b",
        "27.01.1",
        "26.09.100",
        "dev-a",
        "26.10.2",
      ].toSorted(compareReleaseIds)
    ).toStrictEqual([
      "dev-a",
      "dev-b",
      "26.09.100",
      "26.10.2",
      "26.10.9",
      "26.10.10",
      "27.01.1",
    ]);
  });

  it("is YY.MM.N with a real month and N from 1, or a local build's", () => {
    const valid = ["26.10.42", "26.01.1", "99.12.999999999", "dev-mabc12"];
    const invalid = [
      "r007122-e8034b0",
      "26.10.0",
      "26.10.07",
      "26.13.1",
      "26.00.1",
      "2026.10.1",
      "26.1.1",
      "26.10.1/..",
      "",
    ];
    expect(
      valid.filter((id) => !releaseIdSchema.safeParse(id).success)
    ).toStrictEqual([]);
    expect(
      invalid.filter((id) => releaseIdSchema.safeParse(id).success)
    ).toStrictEqual([]);
  });
});
