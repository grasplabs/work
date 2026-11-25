import { describe, expect, it } from "vite-plus/test";

import { practiceSchema } from "./practice.ts";

// A practice company as the lab keeps it (practice.json), read back before
// its interviews are scored.

/** A practice with one person a model played, as an earlier run kept it. */
const keptWith = (played: Record<string, unknown>) => ({
  id: "acme-1",
  key: "01",
  locale: "en",
  made: "2026-10-05T10:00:00.000Z",
  lead: { id: "lead-1", name: "Wim" },
  people: [
    {
      id: "p-1",
      employee: "e-1",
      name: "Oli",
      played: {
        people: "ideal",
        said: [["I open the invoice."]],
        notesAt: [1],
        phaseAt: ["steps"],
        readbackFrom: 1,
        moves: [null],
        untrue: [[]],
        wantsAt: ["answer"],
        left: false,
        minutes: 9,
        ...played,
      },
    },
  ],
  via: { quick: null, careful: null },
});

describe("a practice read back", () => {
  it("is Stephen's when it says so or says nothing of who held it", () => {
    expect([
      practiceSchema.safeParse(keptWith({ interviewer: "stephen" })).success,
      practiceSchema.safeParse(keptWith({})).success,
    ]).toStrictEqual([true, true]);
  });

  it("is refused when Claire held it, so her interviews are never scored as his", () => {
    expect(
      practiceSchema.safeParse(keptWith({ interviewer: "claire" })).success
    ).toBeFalsy();
  });
});
