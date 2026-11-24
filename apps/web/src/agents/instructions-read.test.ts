import { describe, expect, it } from "vite-plus/test";

import { foldOf, mentionOf, withMentions } from "./instructions-read.ts";
import type { Named } from "./instructions-read.ts";

const named: Named[] = [
  { name: "Exact Online", kind: "app" },
  { name: "Exact", kind: "app" },
  { name: "Sanne de Wit", kind: "person" },
];

describe("an agent's instructions as its page reads them", () => {
  it("links each app and person it names, as written, the longest name first", () => {
    expect(
      withMentions("Look in Exact Online, then ask Sanne de Wit.", named)
    ).toBe(
      "Look in [Exact Online](grasp-mention:app), then ask [Sanne de Wit](grasp-mention:person)."
    );
  });

  it("finds a name only as written and as a whole word, never in code, a link or a picture's place", () => {
    const source =
      "Exactly so, exact is a word, Hi!Exact stays text, so does \\Exact. `Exact` stays code, [Exact](https://example.com) stays a link.";
    expect(withMentions(source, named)).toBe(source);
  });

  it("keeps brackets in a name from closing its link", () => {
    expect(
      withMentions("Use Sales [EU] daily.", [
        { name: "Sales [EU]", kind: "app" },
      ])
    ).toBe("Use [Sales \\[EU\\]](grasp-mention:app) daily.");
  });

  it("reads the kind a mention names, and nothing from any other address", () => {
    expect(
      [
        "grasp-mention:app",
        "grasp-mention:person",
        "grasp-mention:x",
        "https://a.test",
      ].map((href) => mentionOf(href))
    ).toStrictEqual(["app", "person", undefined, undefined]);
  });

  it("folds on whole blocks, a list counting as one", () => {
    const source = "First.\n\n- one\n- two\n\nThird.\n\nFourth.";
    expect([foldOf(source, 2), foldOf("Only.", 2)]).toStrictEqual([
      { blocks: 4, folded: "First.\n\n- one\n- two" },
      { blocks: 1, folded: "Only." },
    ]);
  });

  it("keeps the link definitions a folded part's reference links need", () => {
    const source =
      "See [the policy][p].\n\nSecond.\n\nThird.\n\n[p]: https://a.test";
    expect(foldOf(source, 1)).toStrictEqual({
      blocks: 3,
      folded: "See [the policy][p].\n\n[p]: https://a.test",
    });
  });
});
