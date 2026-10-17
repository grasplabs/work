import { describe, expect, it } from "vite-plus/test";

import { missingOf } from "../../src/admin/admin-missing.ts";
import { adminViewOf } from "../../src/admin/admin-view.ts";
import { recordOf } from "../../src/admin/onboarding-admin-record.ts";
import type {
  StepRecord,
  WorkRecord,
} from "../../src/admin/onboarding-admin-record.ts";
import { SAMPLE_ORGS } from "./fixtures/admin-sample.ts";

const [noordkade] = SAMPLE_ORGS;
const view = adminViewOf(noordkade, noordkade.seed, "2026-10-02");
const found = recordOf(view, "claims");
if (found === null) {
  throw new Error("Noordkade's sample has no claims to record");
}
const claims = found;

const step = (text: string, more: Partial<StepRecord> = {}): StepRecord => ({
  text,
  people: 3,
  ways: [],
  documented: false,
  enough: true,
  other: null,
  ...more,
});
/** The claims record with everything said, changed where a test needs something to lack. */
const record = (more: Partial<WorkRecord> = {}): WorkRecord => ({
  ...claims,
  toAsk: 0,
  steps: [step("Write the claim."), step("Ask for photos.")],
  volume: { quiet: [10, 12], busy: [20, 24], people: 3 },
  takes: { least: 10, most: 40, normal: [15, 20], people: 3 },
  wrong: { outOfTen: [1, 2], people: 3 },
  starts: { text: "A client calls.", people: 3 },
  right: { text: "The insurer has it.", people: 3 },
  next: { text: "The insurer.", people: 3 },
  ...more,
});

describe("what a piece of work still lacks", () => {
  it("lacks nothing once everyone talked and said everything", () => {
    expect(missingOf(record())).toStrictEqual([]);
  });

  it("puts a step told two ways that nobody explained first, then the people, then the rest", () => {
    const lacks = missingOf(
      record({
        toAsk: 2,
        steps: [
          step("Write the claim."),
          step("Ask for photos.", {
            other: {
              text: "By phone.",
              people: 1,
              why: "conflict",
              explained: false,
            },
          }),
          step("Send it.", { enough: false, people: 1 }),
        ],
        wrong: null,
      }),
      ["Who checks the photos?"]
    );
    expect(lacks).toStrictEqual([
      { kind: "difference", step: 1, text: "Ask for photos." },
      { kind: "people", count: 2 },
      {
        kind: "step",
        step: 2,
        text: "Send it.",
        people: 1,
        needed: claims.needed,
      },
      { kind: "number", which: "wrong" },
      { kind: "question", text: "Who checks the photos?" },
    ]);
  });

  it("leaves a difference that was explained out", () => {
    const explained = step("Ask for photos.", {
      other: {
        text: "By phone.",
        people: 1,
        why: "condition",
        because: "Large claims go by phone.",
        explained: true,
      },
    });
    expect(missingOf(record({ steps: [explained] }))).toStrictEqual([]);
  });

  it("says many steps short of people as one thing: more people have to talk", () => {
    const steps = ["a", "b", "c", "d", "e"].map((text, index) =>
      step(text, { enough: index === 0, people: 1 })
    );
    expect(missingOf(record({ steps }))).toStrictEqual([
      { kind: "steps", count: 4, of: 5, needed: claims.needed },
    ]);
  });

  it("asks only for the people while nobody who does it has talked", () => {
    const lacks = missingOf(
      record({
        interviews: [],
        toAsk: 4,
        volume: null,
        takes: null,
        steps: [step("a", { enough: false, people: 0 })],
      })
    );
    expect(lacks).toStrictEqual([{ kind: "people", count: 4 }]);
  });

  it("names the parts around the steps nobody gave", () => {
    const none = { text: "", people: 0 };
    expect(
      missingOf(record({ starts: none, right: none, next: none })).map(
        (each) => (each.kind === "around" ? each.which : each.kind)
      )
    ).toStrictEqual(["starts", "right", "next"]);
  });
});
