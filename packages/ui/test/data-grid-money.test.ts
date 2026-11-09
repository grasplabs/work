import { v } from "@grasp-os/sdk";
import { describe, expect, it } from "vite-plus/test";

import { shownCell } from "../src/internal/data-grid-cells.ts";
import { dataGridTexts } from "../src/internal/data-grid-text.ts";

// Money in a grid's cell (pure logic): an amount of whole minor units,
// divided by its currency's ISO 4217 decimals, never by what `Intl`
// guesses in one engine or another. `Intl` puts a no-break space between
// a currency code and its amount.

const money = v.money().descriptor;

/** Money as a cell shows it in English. */
const shown = (minorUnits: number, currency: string): string =>
  shownCell({ minorUnits, currency }, money, dataGridTexts.en, "en");

describe("money in a cell", () => {
  it("divides by its currency's ISO 4217 decimals", () => {
    expect({
      forint: shown(123_456, "HUF"),
      yen: shown(1200, "JPY"),
      dinar: shown(1500, "IQD"),
      euro: shown(500_050, "EUR"),
    }).toStrictEqual({
      forint: "HUF\u00A01,234.56",
      yen: "¥1,200",
      dinar: "IQD\u00A01.500",
      euro: "€5,000.50",
    });
  });

  it("shows a unit with no minor unit as its units, and a code it doesn't know as it is", () => {
    expect([shown(5, "XDR"), shown(5, "ZZZ")]).toStrictEqual([
      "XDR\u00A05",
      "ZZZ 5",
    ]);
  });
});
