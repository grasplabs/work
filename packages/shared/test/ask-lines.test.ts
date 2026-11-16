import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { chatAskSchema } from "../src/chat.ts";

// A question the agent asks (chat.ts `askLine`): one line of text a person
// sees as it is. Standard emoji are text people read, selectors and joiners
// included; a character drawn as nothing outside one is refused.

/** Whether a question reading `question` is taken. */
const taken = (question: string): boolean =>
  chatAskSchema.safeParse({
    questions: [
      {
        kind: "choice",
        question,
        options: [{ label: "Yes" }, { label: "No" }],
      },
    ],
  }).success;

describe("a question's line", () => {
  it("takes standard emoji, with their selectors, modifiers and joiners", () => {
    const emoji = {
      heart: "\u2764\uFE0F",
      warning: "\u26A0\uFE0F",
      sun: "\u2600\uFE0F",
      keycap: "1\uFE0F\u20E3",
      thumbToned: "\u{1F44D}\u{1F3FD}",
      flag: "\u{1F1F3}\u{1F1F1}",
      check: "\u2705",
      family: "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
      scotland:
        "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
    };

    expect(
      Object.fromEntries(
        Object.entries(emoji).map(([name, shown]) => [
          name,
          taken(`Ship it ${shown} today?`),
        ])
      )
    ).toStrictEqual(
      Object.fromEntries(Object.keys(emoji).map((name) => [name, true]))
    );
  });

  it("refuses a character drawn as nothing outside an emoji: a filler, a selector payload after a letter, a lone selector", () => {
    expect({
      filler: taken("Ship itㅤ today?"),
      payload: taken("Ship it\u{E0101}\u{E0142} today?"),
      loneSelector: taken("Ship it Y️ today?"),
    }).toStrictEqual({ filler: false, payload: false, loneSelector: false });
  });
});

describe("a question's line where the runtime can't build the emoji pattern", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("falls back to the stricter rule: an emoji's selector is refused, plain text taken", async () => {
    // A browser without the `v` flag, which `RGI_Emoji` needs.
    vi.stubGlobal(
      "RegExp",
      new Proxy(RegExp, {
        construct: (target, args: [string, string?]) => {
          if (args[1]?.includes("v") === true) {
            throw new SyntaxError(
              "Invalid flags supplied to RegExp constructor"
            );
          }
          return Reflect.construct(target, args);
        },
      })
    );
    vi.resetModules();
    const { chatAskSchema: older } = await import("../src/chat.ts");
    const takenThere = (question: string): boolean =>
      older.safeParse({
        questions: [
          {
            kind: "choice",
            question,
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      }).success;

    expect({
      heart: takenThere("Ship it \u2764\uFE0F today?"),
      plain: takenThere("Ship it today?"),
    }).toStrictEqual({ heart: false, plain: true });
  });
});
