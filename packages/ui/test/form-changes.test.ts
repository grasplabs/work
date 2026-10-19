import { describe, expect, it } from "vite-plus/test";

import { changesTextFor, shownValue } from "../src/form.tsx";

// How the changes list of a record form (FormChanges) says a field's
// value, and in which language: the frame's document says the page's.

describe("a changed field's value", () => {
  it("says an empty text and no value apart, and shows the rest as it is", () => {
    const text = changesTextFor("en");
    expect({
      empty: shownValue("", text),
      none: shownValue(null, text),
      missing: shownValue(undefined, text),
      text: shownValue("Plan", text),
      number: shownValue(0, text),
      list: shownValue(["a"], text),
    }).toStrictEqual({
      empty: "(empty)",
      none: "(no value)",
      missing: "(no value)",
      text: "Plan",
      number: "0",
      list: '["a"]',
    });
  });

  it("is said in the page's language, a regional one included, and in English otherwise", () => {
    expect({
      de: shownValue("", changesTextFor("de")),
      deAt: shownValue(null, changesTextFor("de-AT")),
      nl: shownValue(null, changesTextFor("nl")),
      es: shownValue("", changesTextFor("es")),
      fr: shownValue(null, changesTextFor("fr")),
      other: shownValue(null, changesTextFor("ja")),
      none: changesTextFor("").title,
    }).toStrictEqual({
      de: "(leer)",
      deAt: "(kein Wert)",
      nl: "(geen waarde)",
      es: "(vacío)",
      fr: "(aucune valeur)",
      other: "(no value)",
      none: "This changed since you started editing",
    });
  });
});
