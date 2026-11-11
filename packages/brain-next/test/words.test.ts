import { describe, expect, it } from "vite-plus/test";

import {
  foldForSearch,
  indexedOf,
  languages,
  primaryLetters,
  stemsOf,
  termsOf,
} from "../src/words.ts";

// The pure parts of word search: stems, folding and the question's terms.
// Recall through core, with access, is tested in apps/core.

/** Whether `one` and `other` share their stem in some language. */
const shareStem = (one: string, other: string): boolean => {
  const [a, b] = [stemsOf(foldForSearch(one)), stemsOf(foldForSearch(other))];
  return languages.some((language) => a[language] === b[language]);
};

describe("stems", () => {
  it("reduces inflected forms to a shared stem in each of the five languages", () => {
    const pairs = [
      // English
      ["invoices", "invoice"],
      ["meetings", "meeting"],
      ["companies", "company"],
      ["salaries", "salary"],
      // Dutch
      ["facturen", "factuur"],
      ["roosters", "rooster"],
      ["medewerkers", "medewerker"],
      ["vergaderingen", "vergadering"],
      ["afspraken", "afspraak"],
      ["bestellingen", "bestelling"],
      ["kinderen", "kind"],
      // German
      ["Rechnungen", "Rechnung"],
      ["Mitarbeitern", "Mitarbeiter"],
      ["Verträge", "Vertrag"],
      ["Häuser", "Haus"],
      // French
      ["factures", "facture"],
      ["livraisons", "livraison"],
      ["réalisées", "réaliser"],
      // Spanish
      ["facturas", "factura"],
      ["pedidos", "pedido"],
      ["clientes", "cliente"],
    ] as const;

    expect(
      pairs.filter(([one, other]) => !shareStem(one, other))
    ).toStrictEqual([]);
  });

  it("keeps apart words that only look alike", () => {
    expect(shareStem("rooster", "roest")).toBeFalsy();
    expect(shareStem("invoice", "voice")).toBeFalsy();
  });

  it("matches a word too long for any language only as written", () => {
    const long = "x".repeat(100);

    expect(Object.values(stemsOf(`${long}s`))).toStrictEqual(
      languages.map(() => `${long}s`)
    );
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
});

describe("what the index holds", () => {
  const multilingual = [
    "De facturen van de leveranciers zijn betaald.",
    "Die Rechnungen der Lieferanten sind bezahlt.",
    "Les factures des fournisseurs sont payées.",
    "Las facturas de los proveedores están pagadas.",
    "The suppliers' invoices are paid.",
  ].join("\n");

  it("never holds more in any column than the folded text", () => {
    for (const text of [
      multilingual,
      "ß".repeat(10_000),
      "ﷺ ".repeat(10_000),
      Array.from({ length: 10_000 }, (_, index) => `w${index}ingen`).join(" "),
    ]) {
      const { words, stems } = indexedOf(text);
      const most = foldForSearch(text).length;

      expect(words.length).toBeLessThanOrEqual(most);
      for (const language of languages) {
        expect(stems[language].length).toBeLessThanOrEqual(most);
      }
    }
  });

  it("holds each word once, and each stem once per language", () => {
    const { words, stems } = indexedOf("facturen factuur Facturen");

    expect(words).toBe("facturen factuur");
    expect(stems.nl).toBe("factur");
  });
});

describe("a question's terms", () => {
  it("leaves out stop words when any other word is left", () => {
    expect(
      termsOf("Wat is de status van het factuur?").map(({ exact }) => exact)
    ).toStrictEqual(['"status"', '"factuur"']);
    expect(
      termsOf("Où sont les factures de la société").map(({ exact }) => exact)
    ).toStrictEqual(['"factures"', '"societe"']);
  });

  it("keeps a question of stop words alone whole", () => {
    expect(
      termsOf("to be or not to be").map(({ exact }) => exact)
    ).toStrictEqual(['"to"', '"be"', '"or"', '"not"']);
  });

  it("asks for each stem in its own language's column, as quoted words", () => {
    expect(termsOf("facturen")).toStrictEqual([
      {
        exact: '"facturen"',
        stems:
          'en : "facturen" OR nl : "factur" OR de : "factur" OR fr : "facturen" OR es : "factur"',
      },
    ]);
  });
});
