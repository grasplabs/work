import { describe, expect, it } from "vite-plus/test";

import { packItemTokens, recallLimit, tokensOf } from "../src/contract.ts";
import { exactsOf } from "../src/exact.ts";
import { fuse, packOf, quoteMaxLength, quoteOf } from "../src/pack.ts";
import type { Found } from "../src/pack.ts";
import { termsOf } from "../src/words.ts";

// The pure parts of the pack: the token estimate, fusion by rank, the
// quote, and fitting to a budget. Recall through core, with access, is
// tested in apps/core (brain-next-pack.test.ts).

/** A chunk found, by its row, with `text`. */
const chunk = (row: number, text = `Chunk ${row}.`): Found => ({
  row,
  source: `upload:${row}`,
  version: 1,
  position: 0,
  text,
  found: "words",
});

/** What a question asks a quote for. */
const askedOf = (question: string) => ({
  terms: termsOf(question).telling,
  exacts: exactsOf(question),
});

/** A seeded generator: the same draws for the same seed. */
const drawsOf = (seed: number) => {
  let state = seed;
  return (bound: number): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % bound;
  };
};

/** Words in several scripts and widths, from one to four bytes a character. */
const alphabet = [
  "factuur",
  "Rechnung",
  "financiële",
  "ü",
  "договор",
  "請求書",
  "🧾",
  "𝔉𝔞𝔨𝔱𝔲𝔯",
  "INV-2024-0042",
  ".",
  "\n\n",
];

describe("the token estimate", () => {
  it("counts a third of a token per ASCII letter or space, a token per other ASCII character or two-byte character, and a token per byte past that", () => {
    expect(
      [
        "",
        "abc",
        "abcd",
        "The invoice is paid.",
        "INV-2024-0042: € 1.250,00",
        "financiële",
        "請求書",
        "🧾",
        "line\nline",
      ].map((text) => tokensOf(text))
    ).toStrictEqual([0, 1, 2, 8, 24, 4, 9, 4, 4]);
  });
});

describe("fusion by rank", () => {
  it("puts a chunk two ways find above those one way finds, and the first list's first on a tie", () => {
    const [a, b, c, d] = [1, 2, 3, 4].map((row) => chunk(row));
    if (
      a === undefined ||
      b === undefined ||
      c === undefined ||
      d === undefined
    ) {
      throw new Error("Four chunks");
    }
    // c is third in the first list and second in the second: above both
    // firsts. a and b tie on 1/61: a's list was given first.
    expect(
      fuse([
        [a, d, c],
        [b, c],
      ]).map(({ row }) => row)
    ).toStrictEqual([3, 1, 2, 4]);
  });

  it("keeps how the first list found a chunk it shares with another", () => {
    const exact = { ...chunk(1), found: "exact" as const };
    expect(fuse([[exact], [chunk(1)]])).toStrictEqual([exact]);
  });
});

describe("the quote", () => {
  it("is the sentence holding the most of the question's exact parts, then its words in any form", () => {
    const text =
      "The board met in May. Invoices are paid within thirty days. Invoice INV-7 was paid late, in June.";
    expect(quoteOf(text, askedOf("when are invoices paid"))).toBe(
      "Invoices are paid within thirty days."
    );
    expect(quoteOf(text, askedOf("was INV-7 paid"))).toBe(
      "Invoice INV-7 was paid late, in June."
    );
  });

  it("is a piece of a sentence too long to quote, cut at whitespace", () => {
    const text = `${"lorem ".repeat(100)}payment ${"ipsum ".repeat(100)}`;
    const quote = quoteOf(text, askedOf("payment"));
    expect(quote.length).toBeLessThanOrEqual(quoteMaxLength);
    expect(quote).toContain("payment");
    expect(text).toContain(quote);
  });
});

describe("a pack", () => {
  it("never passes its budget, multi-byte text and chunks larger than the budget included, and says when it was cut short", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const draw = drawsOf(seed);
      const found = Array.from(
        { length: 1 + draw(2 * recallLimit) },
        (_, row) =>
          chunk(
            row,
            Array.from(
              { length: 1 + draw(400) },
              () => alphabet[draw(alphabet.length)] ?? ""
            )
              .join(" ")
              .trim() || "x"
          )
      );
      const budget = 1 + draw(3000);
      const pack = packOf(found, askedOf("factuur INV-2024-0042"), budget, []);
      const spent = pack.items.reduce(
        (sum, item) => sum + packItemTokens(item),
        0
      );

      expect(spent, `seed ${seed}`).toBeLessThanOrEqual(budget);
      const whole = found.every((one) =>
        pack.items.some((item) => item.whole && item.text === one.text)
      );
      expect(pack.truncated, `seed ${seed}`).toBe(!whole);
      for (const item of pack.items) {
        const from = found.find(({ row }) => `upload:${row}` === item.source);
        expect(from?.text, `seed ${seed}`).toContain(item.text);
      }
    }
  });

  it("gives every chunk's quote before any whole chunk, best first", () => {
    const long = (row: number) =>
      chunk(row, `Payment terms ${row}. ${"Other words here. ".repeat(40)}`);
    const found = [long(1), long(2), long(3)];
    const quotes = found.map((one) => ({
      ...one,
      text: quoteOf(one.text, askedOf("payment")),
    }));
    const quotesOnly = quotes.reduce(
      (sum, { source, version, position, text, found: how }) =>
        sum +
        packItemTokens({
          source,
          version,
          position,
          text,
          whole: false,
          found: how,
        }),
      0
    );
    const pack = packOf(found, askedOf("payment"), quotesOnly, []);

    expect(
      pack.items.map(({ text, whole }) => ({ text, whole }))
    ).toStrictEqual(quotes.map(({ text }) => ({ text, whole: false })));
    expect(pack.truncated).toBeTruthy();
  });

  it("leaves out a chunk whose quote alone is over the budget, and goes on with the next", () => {
    const big = chunk(1, "请".repeat(quoteMaxLength));
    const small = chunk(2, "Small.");
    const pack = packOf([big, small], askedOf("small"), 10, ["missing"]);

    expect(pack).toStrictEqual({
      items: [
        {
          source: "upload:2",
          version: 1,
          position: 0,
          text: "Small.",
          whole: true,
          found: "words",
        },
      ],
      notFound: ["missing"],
      truncated: true,
    });
  });
});
