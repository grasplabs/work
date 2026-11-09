import { describe, expect, it } from "vite-plus/test";

import {
  fieldValueOf,
  isBlank,
  nextFieldBase,
  paramKindOf,
  paramText,
  paramValueOf,
  withPart,
} from "./param-values.ts";
import type { ParamKind } from "./param-values.ts";

/** A field's text once each of `parts` is typed in it, in order. */
const typed = (parts: Record<string, string>): string => {
  let text = "";
  for (const [name, value] of Object.entries(parts)) {
    text = withPart(text, name, value);
  }
  return text;
};

describe("a workflow parameter's field", () => {
  it("takes money as an amount and a currency, and a schedule as cron fields and a time zone", () => {
    const money = { type: "object", "x-grasp-value": { kind: "money" } };
    const schedule = { type: "object", "x-grasp-value": { kind: "schedule" } };
    expect({
      kinds: [
        paramKindOf(money),
        paramKindOf(schedule),
        // A sensitive value is replaced as JSON, never shown in parts.
        paramKindOf(money, true),
      ],
      money: [
        paramValueOf("money", typed({ amount: "5000.5", currency: "eur" })),
        paramValueOf("money", typed({ amount: "12", currency: "JPY" })),
        paramValueOf("money", typed({ amount: "-0.07", currency: "EUR" })),
        // By ISO 4217's decimals, which `Intl` disagrees with in some
        // engines: two for the forint, three for the Iraqi dinar.
        paramValueOf("money", typed({ amount: "12.34", currency: "HUF" })),
        paramValueOf("money", typed({ amount: "1.5", currency: "IQD" })),
        paramValueOf("money", typed({ amount: "12.5", currency: "JPY" })),
        // A currency the catalog doesn't have, or with no minor unit.
        paramValueOf("money", typed({ amount: "1", currency: "ZZZ" })),
        paramValueOf("money", typed({ amount: "1", currency: "XDR" })),
        // More decimals than the currency has, no currency, not a number.
        paramValueOf("money", typed({ amount: "1.234", currency: "EUR" })),
        paramValueOf("money", typed({ amount: "12" })),
        paramValueOf("money", typed({ amount: "1e3", currency: "EUR" })),
      ],
      schedule: [
        paramValueOf(
          "schedule",
          typed({ cron: " 0 8 * * 1 ", timeZone: "Europe/Amsterdam" })
        ),
        paramValueOf("schedule", typed({ cron: "0 8 * * 1" })),
      ],
      shown: [
        paramText("money", { minorUnits: 500_050, currency: "EUR" }),
        paramText("money", { minorUnits: 7, currency: "EUR" }),
        paramText("money", { minorUnits: 1200, currency: "JPY" }),
        paramText("schedule", { cron: "0 8 * * 1", timeZone: "UTC" }),
      ],
      blank: [
        isBlank("money", ""),
        isBlank("money", typed({ amount: " ", currency: "" })),
        isBlank("money", typed({ amount: "1" })),
      ],
    }).toStrictEqual({
      kinds: ["money", "schedule", "json"],
      money: [
        { value: { minorUnits: 500_050, currency: "EUR" } },
        { value: { minorUnits: 12, currency: "JPY" } },
        { value: { minorUnits: -7, currency: "EUR" } },
        { value: { minorUnits: 1234, currency: "HUF" } },
        { value: { minorUnits: 1500, currency: "IQD" } },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ],
      schedule: [
        { value: { cron: "0 8 * * 1", timeZone: "Europe/Amsterdam" } },
        undefined,
      ],
      shown: [
        '{"amount":"5000.50","currency":"EUR"}',
        '{"amount":"0.07","currency":"EUR"}',
        '{"amount":"1200","currency":"JPY"}',
        '{"cron":"0 8 * * 1","timeZone":"UTC"}',
      ],
      blank: [true, true, false],
    });
  });

  it("takes a value by the kind its schema says", () => {
    expect({
      kinds: [
        { type: "boolean" },
        { type: "integer", minimum: 1 },
        { type: "number" },
        { type: "string", maxLength: 64 },
        { type: "object" },
        { type: ["string", "null"] },
        null,
      ].map((schema) => paramKindOf(schema)),
      values: [
        paramValueOf("string", "  spaced  "),
        paramValueOf("string", ""),
        paramValueOf("number", " 4 "),
        paramValueOf("number", "four"),
        paramValueOf("number", " "),
        paramValueOf("json", '{"to":["a"]}'),
        paramValueOf("json", "null"),
        paramValueOf("json", "{"),
      ],
      shown: [
        paramText("string", "plain"),
        paramText("number", 4),
        paramText("json", { a: [1] }),
        // A string in a JSON field (a nullable string's) keeps its quotes.
        paramText("json", "hello"),
        paramText("json", "null"),
      ],
      // A sensitive field as it started is nothing typed, a switch too.
      sensitive: [
        fieldValueOf("boolean", {
          text: "",
          checked: false,
          toggled: false,
          sensitive: true,
        }),
        fieldValueOf("boolean", {
          text: "",
          checked: false,
          toggled: true,
          sensitive: true,
        }),
        fieldValueOf("boolean", {
          text: "",
          checked: false,
          toggled: false,
          sensitive: false,
        }),
        fieldValueOf("string", {
          text: "",
          checked: false,
          toggled: false,
          sensitive: true,
        }),
        fieldValueOf("string", {
          text: "",
          checked: false,
          toggled: false,
          sensitive: false,
        }),
      ],
      // What each field shows reads back as the same value.
      roundTrips: (
        [
          ["string", "plain"],
          ["number", 4],
          ["json", "hello"],
          ["json", "null"],
          ["json", null],
          ["json", { a: [1] }],
        ] as const
      ).map(
        ([kind, value]: readonly [Exclude<ParamKind, "boolean">, unknown]) =>
          paramValueOf(kind, paramText(kind, value))
      ),
    }).toStrictEqual({
      kinds: ["boolean", "number", "number", "string", "json", "json", "json"],
      values: [
        // A string as typed, spaces and all, empty too.
        { value: "  spaced  " },
        { value: "" },
        { value: 4 },
        undefined,
        undefined,
        { value: { to: ["a"] } },
        // Null is a value, not nothing typed.
        { value: null },
        undefined,
      ],
      shown: ["plain", "4", '{"a":[1]}', '"hello"', '"null"'],
      sensitive: [
        undefined,
        { value: false },
        { value: false },
        undefined,
        { value: "" },
      ],
      roundTrips: [
        { value: "plain" },
        { value: 4 },
        { value: "hello" },
        { value: "null" },
        { value: null },
        { value: { a: [1] } },
      ],
    });
  });

  it("takes a newer revision as it may without overwriting another's change", () => {
    const base = { text: "4", checked: false, revision: 1 };
    const sameValue = { text: "4", checked: false, revision: 2 };
    const otherValue = { text: "7", checked: false, revision: 2 };
    expect({
      sameRevision: nextFieldBase(
        base,
        { ...otherValue, revision: 1 },
        {
          edited: false,
          sensitive: false,
        }
      ),
      untouched: nextFieldBase(base, otherValue, {
        edited: false,
        sensitive: false,
      }),
      editedUnchanged: nextFieldBase(base, sameValue, {
        edited: true,
        sensitive: false,
      }),
      editedChanged: nextFieldBase(base, otherValue, {
        edited: true,
        sensitive: false,
      }),
      editedSensitive: nextFieldBase(base, sameValue, {
        edited: true,
        sensitive: true,
      }),
    }).toStrictEqual({
      sameRevision: { base, refill: false },
      // Shows the new value, at its revision.
      untouched: { base: otherValue, refill: true },
      // Keeps what is typed, at the newer revision: nothing changed it.
      editedUnchanged: { base: sameValue, refill: false },
      // Keeps the revision it read: its save is refused as a conflict.
      editedChanged: { base, refill: false },
      editedSensitive: { base, refill: false },
    });
  });
});
