import { describe, expect, test } from "vite-plus/test";

import {
  markdownLimits,
  withinMarkdownLimits,
} from "../src/markdown-limits.ts";

// Which Markdown text a renderer is given (markdown-limits.ts), as pure
// logic: ordinary long answers are, and the shapes that freeze a renderer
// or overflow its stack, each just past its limit, are not.

const { characters, depth, delimiters } = markdownLimits;

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
      length: answer.length > 50_000,
      within: withinMarkdownLimits(answer),
    }).toStrictEqual({ length: true, within: true });
  });

  test.each([
    ["more characters than the limit", "a".repeat(characters + 1)],
    ["block quotes nested past the limit", `${"> ".repeat(depth + 1)}deep`],
    ["list markers nested past the limit", `${"- ".repeat(depth + 1)}deep`],
    [
      "a list nested past the limit by indentation",
      Array.from(
        { length: 2 * depth + 4 },
        (_, level) => `${"  ".repeat(level)}- x`
      ).join("\n"),
    ],
    [
      "nested emphasis past the delimiters in one paragraph",
      `${"*a ".repeat(delimiters / 2)}b${" c*".repeat(delimiters / 2 + 1)}`,
    ],
    [
      "unclosed links past the delimiters in one paragraph",
      "[x](https://a\n".repeat(delimiters + 1),
    ],
  ])("refuses %s", (_name, text) => {
    expect(withinMarkdownLimits(text)).toBeFalsy();
  });

  test("counts delimiters per paragraph: blank lines start again", () => {
    const paragraph = "*a".repeat(delimiters);
    expect({
      paragraphs: withinMarkdownLimits(`${paragraph}\n\n${paragraph}`),
      joined: withinMarkdownLimits(`${paragraph}\n${paragraph}`),
    }).toStrictEqual({ paragraphs: true, joined: false });
  });

  test("takes the deepest nesting it allows", () => {
    expect({
      quotes: withinMarkdownLimits(`${"> ".repeat(depth)}deep`),
      indented: withinMarkdownLimits(`${" ".repeat(4 * depth)}code`),
    }).toStrictEqual({ quotes: true, indented: true });
  });
});
