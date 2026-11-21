import { describe, expect, it } from "vite-plus/test";

import { mentionedIn } from "./mentions.tsx";

// Whether what is typed still mentions a name picked after `@`: its whole
// `@name`, never as the start of a longer one.

describe(mentionedIn, () => {
  it("finds a whole @name anywhere, at the end, or before a stop", () => {
    expect(
      [
        "Ask @Ann about it",
        "Ask @Ann",
        "@Ann, can you?",
        "Ask @Anna, then @Ann.",
      ].map((text) => mentionedIn(text, "Ann"))
    ).toStrictEqual([true, true, true, true]);
  });

  it("finds none in a longer name, without the @, or once it is gone", () => {
    expect(
      ["Ask @Anna", "Ask Ann", "Ask @Ann_b", "Ask @Anné", ""].map((text) =>
        mentionedIn(text, "Ann")
      )
    ).toStrictEqual([false, false, false, false, false]);
  });
});
