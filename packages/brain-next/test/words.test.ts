import { describe, expect, it } from "vite-plus/test";

import {
  foldForSearch,
  indexedOf,
  primaryLetters,
  termsOf,
  wordsOf,
} from "../src/words.ts";

// The pure parts of word search: stems, folding and the question's terms.
// Recall through core, with access and ranking, is tested in apps/core.

/** `text`'s words and their stems. */
const formsOf = (text: string): Set<string> =>
  new Set(wordsOf(text).flatMap(({ word, stems }) => [word, ...stems]));

/** Whether `one` and `other` match as recall matches words: by a shared stem. */
const matches = (one: string, other: string): boolean => {
  const otherForms = formsOf(other);
  return [...formsOf(one)].some((form) => otherForms.has(form));
};

describe("stems", () => {
  it("matches inflected forms in each of the five languages, accented or not", () => {
    const pairs = [
      // English
      ["invoices", "invoice"],
      ["companies", "company"],
      ["generalization", "generalize"],
      // Dutch: plurals, diminutives, past tenses and participles
      ["facturen", "factuur"],
      ["huizen", "huis"],
      ["huisje", "huis"],
      ["kopje", "kop"],
      ["brieven", "brief"],
      ["werkte", "werken"],
      ["gewerkt", "werken"],
      ["vergaderingen", "vergadering"],
      // German
      ["Rechnungen", "Rechnung"],
      ["Verträge", "Vertrag"],
      ["Häuser", "Haus"],
      // French, whose rules turn on the accents
      ["employée", "employé"],
      ["arrivée", "arriver"],
      ["factures", "facture"],
      // Spanish
      ["informaciones", "información"],
      ["comió", "comer"],
      ["facturas", "factura"],
      // Typed without the accents
      ["employee", "employé"],
      ["informacion", "informaciones"],
    ] as const;

    expect(pairs.filter(([one, other]) => !matches(one, other))).toStrictEqual(
      []
    );
  });

  it("keeps apart words that only look alike", () => {
    expect(matches("rooster", "roest")).toBeFalsy();
    expect(matches("invoice", "voice")).toBeFalsy();
  });

  it("matches a word too long for any language only as written", () => {
    const long = "x".repeat(100);

    expect(matches(`${long}s`, long)).toBeFalsy();
    expect(matches(`${long}s`, `${long}s`)).toBeTruthy();
  });
});

describe("the random permission test's words", () => {
  // apps/core/test/brain-next-random.test.ts builds its words so that its
  // brute-force answer knows their forms without stemming: three forms of
  // each root that match each other, and never another root or one of its
  // stop words. A stemmer that stems them otherwise fails here, by name.
  const roots = ["a", "b", "c", "d"];
  const forms = ["kamp", "kamps", "kampen"];
  const stopWords = ["de", "het", "the", "und", "les", "los"];
  // Prefixes as the test makes them: "r" and eight hex digits.
  const prefixes = Array.from(
    { length: 64 },
    (_, index) =>
      `r${(((index + 1) * 2_654_435_761) % 2 ** 32).toString(16).padStart(8, "0")}`
  );

  it("matches the forms of one root, and nothing else", () => {
    const wrong: string[] = [];
    for (const prefix of prefixes) {
      const words = roots.map((root) =>
        forms.map((form) => `${prefix}${root}${form}`)
      );
      for (const [index, own] of words.entries()) {
        for (const one of own) {
          for (const other of own) {
            if (!matches(one, other)) {
              wrong.push(`${one} and ${other} apart`);
            }
          }
          for (const [otherIndex, others] of words.entries()) {
            for (const other of otherIndex === index ? [] : others) {
              if (matches(one, other)) {
                wrong.push(`${one} matches ${other}`);
              }
            }
          }
          for (const stop of stopWords) {
            if (matches(one, stop)) {
              wrong.push(`${one} matches ${stop}`);
            }
          }
        }
      }
    }
    for (const one of stopWords) {
      for (const other of stopWords) {
        if (one !== other && matches(one, other)) {
          wrong.push(`${one} matches ${other}`);
        }
      }
    }

    expect(wrong).toStrictEqual([]);
  });
});

describe("folding", () => {
  it("writes letters as the root collation counts them at primary strength", () => {
    const collator = new Intl.Collator("und", { sensitivity: "base" });

    for (const [letter, as] of Object.entries(primaryLetters)) {
      expect({ letter, equal: collator.compare(letter, as) }).toStrictEqual({
        letter,
        equal: 0,
      });
    }
    expect(foldForSearch("Straße STRAẞE Ørsted Æble cœur ΟΔΟΣ")).toBe(
      "strasse strasse orsted aeble coeur οδοσ"
    );
  });

  it("keeps Turkish dotless ı apart from i, and folds dotted İ to i", () => {
    expect(foldForSearch("KILIÇ kılıç")).toBe("kilic kılıc");
    expect(foldForSearch("İstanbul")).toBe("istanbul");
  });

  it("finds no word in marks alone", () => {
    expect(wordsOf("❤️ ok")).toStrictEqual(wordsOf("ok"));
  });
});

describe("what the index holds", () => {
  const multilingual = [
    "De facturen van de leveranciers zijn betaald.",
    "Die Rechnungen der Lieferanten sind bezahlt.",
    "Les factures des fournisseurs sont payées.",
    "Las facturas de los proveedores están pagadas.",
    "The suppliers' invoices are paid.",
  ].join("\n");

  it("holds no more words than the folded text, and at most ten stems no longer than each word", () => {
    for (const text of [
      multilingual,
      "ß".repeat(10_000),
      "ﷺ ".repeat(10_000),
      Array.from({ length: 10_000 }, (_, index) => `w${index}ingen`).join(" "),
      Array.from({ length: 1000 }, (_, index) => `é${index}ées`).join(" "),
    ]) {
      expect(indexedOf(text).words.length).toBeLessThanOrEqual(
        foldForSearch(text).length
      );
      expect(
        wordsOf(text).filter(
          ({ word, stems }) =>
            stems.length > 10 || stems.some((stem) => stem.length > word.length)
        )
      ).toStrictEqual([]);
    }
  });

  it("indexes a chunk the same way whether or not the add stemmed its words before", () => {
    const memo = new Map();
    indexedOf(multilingual, memo);

    expect(indexedOf(multilingual, memo)).toStrictEqual(
      indexedOf(multilingual)
    );
  });
});

/** A question's telling words and stop words, as recall asks for them. */
const wordsAsked = (question: string) => {
  const { telling, stops } = termsOf(question);
  return { telling: telling.map(({ exact }) => exact), stops };
};

describe("a question's terms", () => {
  it("tells its stop words apart, to rank on them after the others", () => {
    expect(wordsAsked("Wat is de status van het factuur?")).toStrictEqual({
      telling: ['"status"', '"factuur"'],
      stops: ['"wat"', '"is"', '"de"', '"van"', '"het"'],
    });
  });

  it("asks a question of stop words alone for them", () => {
    expect(wordsAsked("to be or not to be")).toStrictEqual({
      telling: ['"to"', '"be"', '"or"', '"not"'],
      stops: [],
    });
  });

  it("keeps the word of an English contraction a word that matters", () => {
    expect(wordsAsked("won't pay").telling).toStrictEqual(['"won"', '"pay"']);
  });
});
