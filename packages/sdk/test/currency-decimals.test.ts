import { describe, expect, it } from "vite-plus/test";

import { currencyDecimals } from "../src/index.ts";

// A currency's minor-unit decimals (pure logic): ISO 4217's, pinned in the
// SDK, never what `Intl` answers in one engine or another.

describe("a currency's decimals", () => {
  it("are ISO 4217's, where engines disagree too", () => {
    expect(
      ["EUR", "HUF", "IDR", "JPY", "KRW", "IQD", "KWD"].map(currencyDecimals)
    ).toStrictEqual([2, 2, 2, 0, 0, 3, 3]);
  });

  it("are none for a code the catalog lacks, or a unit with no minor unit", () => {
    expect(
      ["ZZZ", "eur", "XDR", "XSU", "", "__proto__"].map(currencyDecimals)
    ).toStrictEqual(Array.from({ length: 6 }));
  });
});
