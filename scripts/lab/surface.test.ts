/**
 * How someone types (surface.ts): the noise put on an answer after the
 * model wrote it, decided by a profile and a seed. No model here.
 */
import { describe, expect, it } from "vite-plus/test";

import { openKeys } from "./keys/index.ts";
import {
  clean,
  messyShare,
  protectedOf,
  surfaceFor,
  typed,
} from "./surface.ts";
import type { Surface } from "./surface.ts";

const only = (change: Partial<Surface>): Surface => ({ ...clean, ...change });

const answer =
  "Every morning I open the invoice list and check which ones came in overnight. Then I match them to the orders. If one is off I send it back to the supplier.";

/** The seeds 0 to `count`, typed. */
const across = (count: number, say: string, surface: Surface) =>
  Array.from({ length: count }, (_, at) => typed(say, surface, `s${at}`));

describe("someone who types clean", () => {
  it("sends the answer as the model wrote it, in one message", () => {
    expect(typed(answer, clean, "x")).toStrictEqual({
      text: answer,
      parts: [answer],
    });
  });
});

describe("each kind of noise", () => {
  it("typos swap, leave out or double a letter, and leave the word's length within one", () => {
    const noisy = typed(answer, only({ typos: 1 }), "t").text;
    const before = answer.split(" ");
    const after = noisy.split(" ");
    expect(after).toHaveLength(before.length);
    const changed = before.filter((word, at) => word !== after[at]);
    expect(changed.length).toBeGreaterThan(5);
    for (const [at, word] of before.entries()) {
      expect(
        Math.abs((after[at] ?? "").length - word.length)
      ).toBeLessThanOrEqual(1);
    }
    // Short words are left alone.
    const short = before.filter(
      (word) => word.replaceAll(/\W/gu, "").length < 4
    );
    expect(short.length).toBeGreaterThan(0);
    expect(short.every((word) => after.includes(word))).toBeTruthy();
  });

  it("a phone's autocorrect takes the wrong word now and then, and only on a phone", () => {
    const say = "Then their form goes from me to close the week.";
    const swapped = across(40, say, only({ phone: true })).filter(
      ({ text }) => text !== say
    );
    expect(swapped.length).toBeGreaterThan(0);
    expect(swapped.some(({ text }) => text.includes("clothes"))).toBeTruthy();
    expect(
      across(40, say, only({ phone: false })).every(({ text }) => text === say)
    ).toBeTruthy();
  });

  it("capitals never: no sentence starts with one, and 'I' is lower case", () => {
    const { text } = typed(answer, only({ capitals: "never" }), "c");
    expect(text).toMatch(/^every morning i open/u);
    expect(text).toContain(". then i match");
    expect(text).not.toMatch(/\bI\b/u);
  });

  it("capitals rarely: most sentences start small, and some keep their capital", () => {
    const starts = across(30, answer, only({ capitals: "rarely" })).flatMap(
      ({ text }) => text.match(/(?:^|[.!?]\s+)\p{L}/gu) ?? []
    );
    const small = starts.filter((start) => /\p{Ll}$/u.test(start)).length;
    expect(small / starts.length).toBeGreaterThan(0.5);
    expect(small).toBeLessThan(starts.length);
  });

  it("full stops left off at the end of sentences, never inside a number", () => {
    const say = "We had 1.200 of them. It was a lot.";
    const { text } = typed(say, only({ dropsStops: 1 }), "p");
    expect(text).toBe("We had 1.200 of them It was a lot");
  });

  it("splits an answer of several sentences into two or three messages, and never a single sentence", () => {
    const split = across(20, answer, only({ splits: 1 }));
    for (const { text, parts } of split) {
      expect(parts.length === 2 || parts.length === 3).toBeTruthy();
      expect(parts.join(" ")).toBe(text);
      expect(text).toBe(answer);
    }
    expect(split.some(({ parts }) => parts.length === 3)).toBeTruthy();
    expect(
      typed("Just the one sentence here.", only({ splits: 1 }), "o").parts
    ).toHaveLength(1);
  });

  it("someone who mixes says the work terms in Dutch, in an English answer only", () => {
    const mixes = only({ mixesDutch: true });
    expect(typed(answer, mixes, "m").text).toContain("factuur list");
    expect(typed(answer, mixes, "m").text).toContain("the leverancier.");
    const dutch = "Ik open elke ochtend de lijst met facturen.";
    expect(typed(dutch, mixes, "m", { locale: "nl" }).text).toBe(dutch);
  });
});

describe("what the answer key scores by", () => {
  const everything: Surface = {
    typos: 1,
    phone: true,
    capitals: "never",
    dropsStops: 1,
    splits: 1,
    mixesDutch: true,
  };

  it("keeps every number as written", () => {
    const say =
      "About 170 a week, 2,5 hours each, €1.200 a month. Roughly 30% of them come back.";
    for (const { text } of across(20, say, everything)) {
      for (const number of ["170", "2,5", "1.200", "30%"]) {
        expect(text).toContain(number);
      }
    }
  });

  it("keeps the names, systems and terms it is told to keep, whatever else changes", () => {
    const guarded = new Set([
      "marieke",
      "jansen",
      "exact",
      "online",
      "invoice",
    ]);
    const say =
      "Marieke Jansen checks the invoice in Exact Online. Then Marieke sends it on.";
    for (const at of Array.from({ length: 20 }, (_, nth) => nth)) {
      const { text } = typed(say, everything, `g${at}`, { guarded });
      expect(text).toContain("Marieke Jansen");
      expect(text).toContain("Exact Online");
      // A guarded work term is not put in Dutch either.
      expect(text).toContain("invoice");
      // A name keeps its capital where the sentence around it lost its own.
      expect(text).toMatch(/^Marieke Jansen /u);
      expect(text).toMatch(/\s\p{Ll}+ Marieke /u);
    }
  });

  it("takes the names, systems and roles to keep from the answer key", () => {
    const key = openKeys["01"];
    if (key === undefined) {
      throw new Error("Key 01 is missing.");
    }
    const guarded = protectedOf(key);
    const say =
      "Sanne de Vries books it in Exact Online, and Mark Jansen approves it. Then it goes to the controller.";
    for (const at of Array.from({ length: 20 }, (_, nth) => nth)) {
      const { text } = typed(say, everything, `k${at}`, { guarded });
      expect(text).toContain("Sanne de Vries");
      expect(text).toContain("Exact Online");
      expect(text).toContain("Mark Jansen");
      expect(text).toContain("controller");
    }
  });
});

describe("the seed", () => {
  it("types the same answer the same way every time, and another seed another way", () => {
    const messy = surfaceFor("messy-0");
    const noisy: Surface = { ...messy, typos: 0.3 };
    expect(typed(answer, noisy, "a")).toStrictEqual(typed(answer, noisy, "a"));
    expect(typed(answer, noisy, "a").text).not.toBe(
      typed(answer, noisy, "b").text
    );
  });

  it("gives most people a little noise and about one in five a lot", () => {
    const profiles = Array.from({ length: 500 }, (_, at) =>
      surfaceFor(`person-${at}`)
    );
    const messy = profiles.filter(({ typos }) => typos >= 0.06).length;
    expect(messy / profiles.length).toBeGreaterThan(messyShare - 0.06);
    expect(messy / profiles.length).toBeLessThan(messyShare + 0.06);
    expect(
      profiles.every(({ typos }) => typos >= 0.06 || typos < 0.015)
    ).toBeTruthy();
    expect(surfaceFor("same")).toStrictEqual(surfaceFor("same"));
  });
});
