// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vite-plus/test";

import { matchesIn } from "./report-viewer.tsx";

// Find in the report's viewer: what it marks, in the page's words or its
// code, which the code view draws in coloured runs.

/** `html` in a box of its own on the page. */
const boxOf = (html: string): HTMLElement => {
  const box = document.createElement("div");
  box.innerHTML = html;
  document.body.append(box);
  return box;
};

describe("find in the report's viewer", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("finds words across the runs the code is coloured in, case aside, and marks them where they stand", () => {
    const box = boxOf(
      "<span>&lt;</span><span>html</span><span> lang</span>=<span>&quot;en&quot;</span><p>An HTML file</p>"
    );

    const found = matchesIn(box, "<HTML").map(String);
    const all = matchesIn(box, "html").map(String);

    expect({ found, all }).toStrictEqual({
      found: ["<html"],
      all: ["html", "HTML"],
    });
  });

  it("marks a match in words whose capitals change length when lowered, and takes the query's own symbols as text", () => {
    const box = boxOf("<p>İŞ (a+b)</p>");

    expect({
      folded: matchesIn(box, "ş").map(String),
      symbols: matchesIn(box, "(a+b)").map(String),
      blank: matchesIn(box, "  "),
    }).toStrictEqual({ folded: ["Ş"], symbols: ["(a+b)"], blank: [] });
  });
});
