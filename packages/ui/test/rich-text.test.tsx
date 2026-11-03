import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RichText } from "../src/components/rich-text.tsx";

// What a person's formatted text can put on a screen: what it means to
// (bold, lists, a link's words and address), and nothing that runs, loads
// or leaves the screen: no script, no handler, no unsafe address, no
// image fetched from elsewhere.

const shown = (value: string, onOpenLink?: (url: string) => void): string =>
  renderToStaticMarkup(<RichText onOpenLink={onOpenLink} value={value} />);

const attacks = [
  "<script>alert(1)</script>",
  '<img src="x" onerror="alert(1)">',
  "[x](javascript:alert(1))",
  "<javascript:alert(1)>",
  "![x](https://tracker.example/pixel.gif)",
].join("\n\n");

describe("rich text", () => {
  it("renders no element, handler or address an attack puts in it", () => {
    const markup = shown(attacks);
    expect({
      script: markup.includes("<script"),
      image: markup.includes("<img"),
      handler: /\son\w+=/u.test(markup),
      // An unsafe address is dropped: never an attribute's value, at most
      // inert words the person typed.
      javascript: /[=]"[^"]*javascript:/iu.test(markup),
      tracker: markup.includes("tracker.example"),
      anchor: markup.includes("<a"),
    }).toStrictEqual({
      script: false,
      image: false,
      handler: false,
      javascript: false,
      tracker: false,
      anchor: false,
    });
  });

  it("shows what the field formats, headings as bold paragraphs", () => {
    expect(shown("# Plan\n\n**Ship** *it*\n\n- one\n- two")).toBe(
      '<div class="flex flex-col gap-2 text-sm" data-slot="rich-text"><p class="font-semibold">Plan</p>\n<p><strong>Ship</strong> <em>it</em></p>\n<ul class="flex list-disc flex-col gap-1 pl-5">\n<li>one</li>\n<li>two</li>\n</ul></div>'
    );
  });

  it("shows a link's address as text, unless the screen opens links", () => {
    const value = "See [the plan](https://example.com/plan).";
    expect(shown(value)).toContain("the plan (https://example.com/plan)");
    const opening = shown(value, () => {
      // Opens nothing: only how it renders is read.
    });
    expect({
      button: opening.includes("<button"),
      address: opening.includes("https://example.com/plan"),
    }).toStrictEqual({ button: true, address: false });
  });
});
