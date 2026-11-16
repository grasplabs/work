import { describe, expect, it } from "vite-plus/test";

import { shownVisibly } from "../src/chat.ts";

// What a person is shown of text that will be sent as it is (a held
// write's request or values): every character nobody sees as an escape,
// and nothing two different texts could both look like.

describe("text shown before it is sent", () => {
  it("shows each character nobody sees as an escape of its code point, and keeps what reads as text", () => {
    expect({
      tags: shownVisibly("Agenda\u{E0041}\u{E0042}"),
      bidi: shownVisibly("a‮b⁦c"),
      zeroWidth: shownVisibly("a​b‍c﻿"),
      privateUse: shownVisibly("ab"),
      unassigned: shownVisibly("a\u{E0080}b"),
      control: shownVisibly("a\u0007b"),
      loneHalf: shownVisibly("a\uD800b"),
      lines: shownVisibly("a\tb\nc\r\nd"),
      text: shownVisibly('Café 東京 👍 "quoted" & <b>'),
    }).toStrictEqual({
      tags: String.raw`Agenda\u{E0041}\u{E0042}`,
      bidi: String.raw`a\u{202E}b\u{2066}c`,
      zeroWidth: String.raw`a\u{200B}b\u{200D}c\u{FEFF}`,
      privateUse: String.raw`a\u{E000}b`,
      unassigned: String.raw`a\u{E0080}b`,
      control: String.raw`a\u{7}b`,
      loneHalf: String.raw`a\u{D800}b`,
      lines: "a\tb\nc\r\nd",
      text: 'Café 東京 👍 "quoted" & <b>',
    });
  });

  it("never shows a written escape like a hidden character: a backslash that would start one is escaped too", () => {
    const hidden = shownVisibly("a​b");
    const written = shownVisibly(String.raw`a\u{200B}b`);
    // JSON's own escapes stay as they are.
    const json = shownVisibly(JSON.stringify({ title: 'a\\b "c"\n' }));

    expect({ hidden, written, json }).toStrictEqual({
      hidden: String.raw`a\u{200B}b`,
      written: String.raw`a\u{5C}u{200B}b`,
      json: String.raw`{"title":"a\\b \"c\"\n"}`,
    });
  });
});
