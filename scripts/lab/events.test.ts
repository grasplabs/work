/**
 * What happens to people while they are interviewed (events.ts): each
 * person's timetable, decided by their place and their mark, and the
 * pieces code decides of each event. No model here.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  awayLine,
  eventKinds,
  misreadable,
  pasteOf,
  splitOf,
  timetableFor,
} from "./events.ts";

describe("a timetable of events", () => {
  it("gives a practice company of five each kind at least once", () => {
    for (const seed of [1, 2, 3]) {
      const kinds = new Set(
        Array.from({ length: 5 }, (_, place) =>
          timetableFor(place, `01:e${place}:${seed}`)
        )
          .flat()
          .map(({ kind }) => kind)
      );
      expect([...kinds].toSorted()).toStrictEqual([...eventKinds].toSorted());
    }
  });

  it("is the same for the same mark, earliest first, one event a minute, between the first questions and the read-back", () => {
    expect(timetableFor(2, "m")).toStrictEqual(timetableFor(2, "m"));
    const all = Array.from({ length: 200 }, (_, at) =>
      timetableFor(at, `p${at}`)
    );
    for (const timetable of all) {
      const minutes = timetable.map(({ at }) => at);
      expect(minutes).toStrictEqual(minutes.toSorted((a, b) => a - b));
      expect(new Set(minutes).size).toBe(minutes.length);
      expect(minutes.every((at) => at >= 3 && at <= 20)).toBeTruthy();
    }
    // Most people have only the event of their place; some have more.
    const more = all.filter((timetable) => timetable.length > 1).length;
    expect(more).toBeGreaterThan(20);
    expect(more).toBeLessThan(140);
  });

  it("says how long someone is away: minutes when called away, hours when they come back later", () => {
    const away = Array.from({ length: 100 }, (_, at) =>
      timetableFor(at, `a${at}`)
    ).flat();
    const minutes = away
      .filter(({ kind }) => kind === "interrupted")
      .map((event) => event.away ?? 0);
    const hours = away
      .filter(({ kind }) => kind === "resumes later")
      .map((event) => event.away ?? 0);
    expect(minutes.every((each) => each >= 1 && each <= 4)).toBeTruthy();
    expect(hours.every((each) => each >= 2 && each <= 48)).toBeTruthy();
  });
});

describe("what code decides of each event", () => {
  it("being called away and pasting the wrong thing, in the person's language", () => {
    expect(awayLine("nl", 0)).not.toBe(awayLine("en", 0));
    expect(new Set([0, 1, 2].map((pick) => pasteOf("en", pick))).size).toBe(3);
    expect(pasteOf("nl", 0)).toContain("VERT.ZOEKEN");
  });

  it("a split message stops mid-sentence near the middle, and the two parts are the answer", () => {
    const say =
      "I open the order list first, then I check the prices against the sheet and send it to the warehouse.";
    const [start = "", rest = ""] = splitOf(say) ?? [];
    expect({
      whole: `${start} ${rest}`.replace(" first then", " first, then"),
      stopsMidSentence: /[.!?,]$/u.test(start),
      near: [start, rest].map((part) => part.split(" ").length > 3),
    }).toStrictEqual({
      whole: say,
      stopsMidSentence: false,
      near: [true, true],
    });
    expect(splitOf("Yes, about forty.")).toBeNull();
  });

  it("only a question about how often, how many or how long, or two questions in one, can be misread", () => {
    expect(
      misreadable("How often does that happen in a normal week?")
    ).toBeTruthy();
    expect(misreadable("Hoe lang duurt dat ongeveer?")).toBeTruthy();
    expect(
      misreadable("Who checks it, and where does it go after that?")
    ).toBeTruthy();
    expect(misreadable("What did you do first?")).toBeFalsy();
    expect(misreadable("I see. How many there are matters.")).toBeFalsy();
  });
});
