import type { ExtraProps } from "react-markdown";

// What an answer's code blocks and tables hold, read from the tree
// react-markdown renders them from, and a table written out again as
// Markdown, CSV or TSV to copy or download (chat/answer-markdown.tsx).

/** An element of the rendered tree, as react-markdown hands it over. */
type Element = NonNullable<ExtraProps["node"]>;
type Node = Element | Element["children"][number];

/** The text `node` holds, as it reads: highlighting's spans add none. */
export const textOf = (node: Node | undefined): string => {
  if (node === undefined) {
    return "";
  }
  if (node.type === "text") {
    return node.value;
  }
  if (node.type === "element") {
    return node.children.map(textOf).join("");
  }
  return "";
};

/** The child elements of `node` named `tagName`. */
const childrenNamed = (node: Element, tagName: string): Element[] =>
  node.children.filter(
    (child): child is Element =>
      child.type === "element" && child.tagName === tagName
  );

/** A code block's code, under its `<pre>`. */
export const codeOf = (pre: Element | undefined): Element | undefined =>
  pre === undefined ? undefined : childrenNamed(pre, "code")[0];

/** A fenced block's language, from the class Markdown gives its code. */
const languagePattern = /^language-(?<language>.+)$/u;

/** The language `code` names, if its block named one. */
export const languageOf = (code: Element | undefined): string | undefined => {
  const className = code?.properties.className;
  if (!Array.isArray(className)) {
    return undefined;
  }
  for (const name of className) {
    const language = languagePattern.exec(name)?.groups?.language;
    if (language !== undefined) {
      return language;
    }
  }
  return undefined;
};

/** A table's rows, its header's first, each cell's text. */
export const cellsOf = (table: Element | undefined): string[][] => {
  if (table === undefined) {
    return [];
  }
  const sections = [
    ...childrenNamed(table, "thead"),
    ...childrenNamed(table, "tbody"),
  ];
  return sections.flatMap((section) =>
    childrenNamed(section, "tr").map((row) =>
      row.children
        .filter(
          (cell): cell is Element =>
            cell.type === "element" &&
            (cell.tagName === "th" || cell.tagName === "td")
        )
        .map((cell) => textOf(cell).trim())
    )
  );
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
 * A CSV field: a would-be formula made text with a leading apostrophe
 * (OWASP's CSV injection advice), then quoted when it must be, its quotes
 * doubled (RFC 4180).
 */
const csvField = (cell: string): string => {
  const text =
    csvFormula.test(cell) && !csvNumber.test(cell) ? `'${cell}` : cell;
  return csvSpecial.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** Breaks and tabs, which a TSV field can't hold. */
const tsvSpecial = /[\t\r\n]+/gu;

/** A Markdown cell: its pipes escaped, its breaks a space. */
const markdownCell = (cell: string): string =>
  cell.replaceAll("|", "\\|").replaceAll(/[\r\n]+/gu, " ");

/** `rows`, the first the header, written as `format`. */
export const tableAs = (rows: string[][], format: TableFormat): string => {
  if (format === "csv") {
    return rows.map((row) => row.map(csvField).join(",")).join("\r\n");
  }
  if (format === "tsv") {
    return rows
      .map((row) =>
        row.map((cell) => cell.replaceAll(tsvSpecial, " ")).join("\t")
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
