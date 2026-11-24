import { parseMarkdown } from "@grasp-os/ui/components/markdown";
import type { MarkdownRoot } from "@grasp-os/ui/components/markdown";

// The tables of an answer, read from its Markdown as Damsko's Markdown
// parses it, and each written out again as Markdown, CSV or TSV to copy
// or download (thread.tsx's AnswerTableActions): what main's chat offered
// over each table, kept.

/** A node of the answer's tree, of any kind. */
type Node = MarkdownRoot | MarkdownRoot["children"][number];

/** One of the answer's tables: what it is called, and its rows, the header's first, each cell's words. */
export interface AnswerTable {
  /** The words of the heading right above it: the first table under a heading only. */
  name: string | undefined;
  rows: string[][];
}

/** The nodes inside `node`, of any kind; none for a leaf. */
const childrenOf = (node: Node): readonly Node[] => {
  if (!("children" in node)) {
    return [];
  }
  const inside: readonly Node[] = node.children;
  return inside;
};

/** The words `node` reads as: a picture its alt words, a break a space, code its characters. */
const wordsOf = (node: Node): string => {
  if (
    node.type === "text" ||
    node.type === "inlineCode" ||
    node.type === "html"
  ) {
    return node.value;
  }
  if (node.type === "image" || node.type === "imageReference") {
    return node.alt ?? "";
  }
  if (node.type === "break") {
    return " ";
  }
  return childrenOf(node).map(wordsOf).join("");
};

/** Every table of `markdown`, in the order it shows them. */
export const tablesOf = (markdown: string): AnswerTable[] => {
  const tables: AnswerTable[] = [];
  const visit = (nodes: readonly Node[]): void => {
    // A heading names the one table that follows it; a second under it
    // would share its name, so goes by its place.
    let heading: string | undefined;
    for (const node of nodes) {
      if (node.type === "heading") {
        heading = wordsOf(node).trim() || undefined;
      } else if (node.type === "table") {
        tables.push({
          name: heading,
          rows: node.children.map((row) =>
            row.children.map((cell) => wordsOf(cell).trim())
          ),
        });
        heading = undefined;
      } else {
        visit(childrenOf(node));
      }
    }
  };
  visit(parseMarkdown(markdown).children);
  return tables;
};

export type TableFormat = "markdown" | "csv" | "tsv";

/** What has to be quoted in a CSV field: its quote, its comma, a line break. */
const csvSpecial = /[",\r\n]/u;

/**
 * What a spreadsheet would run as a formula: a cell that starts with one
 * of these. An answer may repeat whatever the agent read, so a table may
 * hold `=HYPERLINK(…)` meant for whoever opens the file.
 */
const csvFormula = /^[=+\-@\t\r]/u;

/** A plain number, such as -5 or +1.5, which a spreadsheet reads as one. */
const csvNumber = /^[+-]?\d+(?:[.,]\d+)*$/u;

/**
 * A cell a spreadsheet will read as text, not run: a would-be formula with
 * a leading apostrophe (OWASP's CSV injection advice). Both CSV and TSV
 * are pasted into or opened in one.
 */
const formulaSafe = (cell: string): string =>
  csvFormula.test(cell) && !csvNumber.test(cell) ? `'${cell}` : cell;

/** A CSV field: formula-safe, then quoted when it must be, its quotes doubled (RFC 4180). */
const csvField = (cell: string): string => {
  const text = formulaSafe(cell);
  return csvSpecial.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** Breaks and tabs, which a TSV field can't hold. */
const tsvSpecial = /[\t\r\n]+/gu;

/**
 * What Markdown would read as syntax in a cell: the backslash itself,
 * emphasis, code, links, HTML and strikethrough, and the cell's own pipe.
 */
const markdownSyntax = /[\\`*_[\]<>|~]/gu;

/** A Markdown cell: its words as written, every character of syntax escaped, its breaks a space. */
const markdownCell = (cell: string): string =>
  cell.replaceAll(markdownSyntax, "\\$&").replaceAll(/[\r\n]+/gu, " ");

/** `rows`, the first the header, written as `format`. */
export const tableAs = (rows: string[][], format: TableFormat): string => {
  if (format === "csv") {
    return rows.map((row) => row.map(csvField).join(",")).join("\r\n");
  }
  if (format === "tsv") {
    return rows
      .map((row) =>
        row
          .map((cell) => formulaSafe(cell).replaceAll(tsvSpecial, " "))
          .join("\t")
      )
      .join("\n");
  }
  const [header = [], ...body] = rows;
  const line = (row: string[]): string =>
    `| ${row.map(markdownCell).join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...body.map(line)].join(
    "\n"
  );
};
