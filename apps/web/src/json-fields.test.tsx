import type { Json } from "@grasp-os/shared/json";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { fieldLabel, JsonFields } from "./json-fields.tsx";

// What a workflow passed, as a person reads it before approving: each
// field by its name in words, each value exactly as passed.

/** The fields' text, as a person reads it: tags gone, spaces collapsed. */
const textOf = (value: Json): string =>
  renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <JsonFields value={value} />
    </I18nProvider>
  )
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();

describe(fieldLabel, () => {
  it("reads a field's name in words, keeping an acronym's capitals", () => {
    expect(
      [
        "invoiceNumber",
        "invoice_number",
        "invoice-number",
        "IBAN",
        "vatID",
      ].map(fieldLabel)
    ).toStrictEqual([
      "Invoice number",
      "Invoice number",
      "Invoice number",
      "IBAN",
      "Vat ID",
    ]);
  });
});

describe("a workflow's input as fields", () => {
  it("shows each value exactly as passed: no amount, rate or year rounded or grouped", () => {
    const text = textOf({ total: 1249.5, rate: 0.19, year: 2026, paid: false });

    expect(text).toContain("1249.5");
    expect(text).toContain("0.19");
    expect(text).toContain("2026");
    expect(text).toContain("Paid No");
  });
});
