import { describe, expect, test } from "vite-plus/test";

import {
  markdownLimits,
  withinMarkdownLimits,
} from "../src/markdown-limits.ts";

// Which Markdown text a renderer is given (markdown-limits.ts), as pure
// logic: ordinary long answers are, and the shapes that freeze a renderer
// or overflow its stack, each just past its limit, are not.

const { characters, depth, openers } = markdownLimits;

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
      "nested emphasis past the openers in one paragraph",
      `${"*a ".repeat(openers + 1)}b${" c*".repeat(openers + 1)}`,
    ],
    [
      "nested emphasis on lines of their own, one paragraph still",
      `${"*a\n".repeat(openers + 1)}b${"\nc*".repeat(openers + 1)}`,
    ],
    [
      "unclosed links past the openers in one paragraph",
      "[x](https://a\n".repeat(openers + 1),
    ],
    [
      "emphasis in a fence that never closes, which counts as text",
      `\`\`\`\n${"*a".repeat(openers + 1)}`,
    ],
    [
      "emphasis after an indented line that only looks like a fence",
      `    \`\`\`\n${"*a".repeat(openers + 1)}\n\`\`\``,
    ],
  ])("refuses %s", (_name, text) => {
    expect(withinMarkdownLimits(text)).toBeFalsy();
  });

  test("counts openers per inline run: a blank line, a heading or a list item starts again; a closed fence holds none", () => {
    const run = "*a".repeat(openers);
    expect({
      paragraphs: withinMarkdownLimits(`${run}\n\n${run}`),
      heading: withinMarkdownLimits(`${run}\n# Next\n${run}`),
      items: withinMarkdownLimits(`- ${run}\n- ${run}`),
      fenced: withinMarkdownLimits(
        `${run}\n\`\`\`\n${run}\n\`\`\`\n${run.slice(2)}`
      ),
      joined: withinMarkdownLimits(`${run}\n${run}`),
      // Indented four columns, a list item may be a paragraph's next line.
      indentedItems: withinMarkdownLimits(`${run}\n    - ${run}`),
    }).toStrictEqual({
      paragraphs: true,
      heading: true,
      items: true,
      fenced: true,
      joined: false,
      indentedItems: false,
    });
  });

  test("counts only what can open: a `_` inside a word, a `*` before a space and a bare `[` can't", () => {
    expect(
      withinMarkdownLimits(
        `${"snake_case_name ".repeat(openers)}${"2 * 3 ".repeat(openers)}${"arr[0] ".repeat(openers)}`
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
