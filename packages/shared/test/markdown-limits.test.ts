import { describe, expect, test } from "vite-plus/test";

import {
  markdownLimits,
  withinMarkdownLimits,
} from "../src/markdown-limits.ts";

// Which Markdown text a renderer is given (markdown-limits.ts), as pure
// logic: ordinary long answers are, and the shapes that freeze a renderer
// or overflow its stack, each just past its limit, are not, wherever they
// sit in the text (a fence, an HTML block, after a blank-looking line).

const { characters, delimiters, footnotes, depth } = markdownLimits;

/** A long ordinary answer: headings, prose, a table, a list and code. */
const section = (index: number) => `## Part ${index}

The *invoice_total* for **supplier_${index}** is due; see [the policy](https://example.com/p/${index}).

| Supplier | Invoice | Days |
| --- | --- | ---: |
| Kantoorhuis_${index} | 2026_${index} | ${index} |

\`\`\`py
def overdue_items(invoices):
    return [inv for inv in invoices if inv.due_date < today()]
\`\`\`

- item_one with *emphasis*
  - nested with **strong** and [a link](https://x.example/${index})

`;

describe("text a Markdown renderer is given", () => {
  test("takes ordinary long answers, tens of kilobytes of prose, tables, lists and code", () => {
    const answer = Array.from({ length: 150 }, (_, index) =>
      section(index)
    ).join("");
    expect({
      length: answer.length > 40_000,
      within: withinMarkdownLimits(answer),
    }).toStrictEqual({ length: true, within: true });
  });

  test.each([
    ["more characters than the limit", "a".repeat(characters + 1)],
    [
      "more emphasis delimiters than the limit",
      "*_".repeat(delimiters / 2 + 1),
    ],
    [
      "more unclosed link addresses than the limit",
      "[x](https://a".repeat(delimiters + 1),
    ],
    ["more code span ticks than the limit", "`a".repeat(delimiters + 1)],
    [
      "more footnotes than the limit, over indented lines",
      `${"[^a]:\n    ".repeat(footnotes + 1)}x`,
    ],
    ["block quotes nested past the limit", `${"> ".repeat(depth + 1)}deep`],
    ["list markers nested past the limit", `${"- ".repeat(depth + 1)}deep`],
    [
      "a list nested past the limit by indentation",
      `${" ".repeat(4 * (depth + 1))}- x`,
    ],
    [
      "nesting after a bare carriage return, a line ending of its own",
      `safe\r${"> ".repeat(depth + 1)}deep`,
    ],
    ["nesting after a line separator", `safe ${"> ".repeat(depth + 1)}deep`],
    [
      "emphasis inside what looks like a fence in an HTML block",
      `<div>\n\`\`\`\n\n${"*_".repeat(delimiters)}\n\`\`\``,
    ],
    [
      "emphasis in paragraphs split by lines that only look blank",
      `${"*a".repeat(250)}\n \n`.repeat(delimiters / 250 + 1),
    ],
  ])("refuses %s", (_name, text) => {
    expect(withinMarkdownLimits(text)).toBeFalsy();
  });

  test("counts only what can delimit: a `_` inside a word, a delimiter between blanks and a bare `[` can't", () => {
    expect(
      withinMarkdownLimits(
        // Counted, they would be more than the limit.
        `${"snake_case_name ".repeat(1500)}${"2 * 3 ".repeat(1500)}${"arr[0] ".repeat(1500)}`
      )
    ).toBeTruthy();
  });

  test("takes the deepest nesting it allows", () => {
    expect({
      quotes: withinMarkdownLimits(`${"> ".repeat(depth)}deep`),
      indented: withinMarkdownLimits(`${" ".repeat(4 * depth)}code`),
    }).toStrictEqual({ quotes: true, indented: true });
  });
});
