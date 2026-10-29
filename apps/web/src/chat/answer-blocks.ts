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
    // An image shows its alt text (knowledge/markdown.tsx): that is its text.
    if (node.tagName === "img") {
      const { alt } = node.properties;
      return typeof alt === "string" ? alt : "";
    }
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

/** A Markdown cell: its text as written, every character of syntax escaped, its breaks a space. */
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

/** How a word lands while Grasp writes: it fades in where it lands. */
const landing = [
  "animate-in",
  "fade-in",
  "duration-300",
  "motion-reduce:animate-none",
];

/** A run of whitespace, kept between the words it parts. */
const spaces = /(?<space>\s+)/u;

/**
 * Puts each word under `node` in a span of its own that fades in, so only
 * a word new to an answer being written does: the words already there keep
 * their spans, and their place. Code, in a block or inline, stays as it
 * is, a whole.
 */
export const landWords = (node: { children: Element["children"] }): void => {
  node.children = node.children.flatMap((child): Element["children"] => {
    if (child.type === "element") {
      if (child.tagName !== "pre" && child.tagName !== "code") {
        landWords(child);
      }
      return [child];
    }
    if (child.type !== "text" || child.value === "") {
      return [child];
    }
    return child.value
      .split(spaces)
      .filter((piece) => piece !== "")
      .map((piece) =>
        piece.trim() === ""
          ? { type: "text", value: piece }
          : {
              type: "element",
              tagName: "span",
              properties: { className: landing },
              children: [{ type: "text", value: piece }],
            }
      );
  });
};
