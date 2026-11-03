// What the rich text field's toolbar does to the text: Markdown put around
// what is selected, or before each selected line, and what to select after.

/** A Markdown mark the rich text toolbar puts around, or before, what is selected. */
export type Mark = "bold" | "italic" | "bullets" | "numbers";

export const marks: readonly Mark[] = ["bold", "italic", "bullets", "numbers"];

/**
 * `text` with `mark` applied to its selection from `start` to `end`, and
 * what to select after: the text marked.
 */
export const applyMark = (
  text: string,
  start: number,
  end: number,
  mark: Mark
): { text: string; start: number; end: number } => {
  if (mark === "bold" || mark === "italic") {
    // Around the words selected, not the spaces at its edges (a
    // double-click takes one): `**word **` isn't bold in Markdown.
    const selection = text.slice(start, end);
    const from = start + (selection.length - selection.trimStart().length);
    const to = Math.max(
      from,
      end - (selection.length - selection.trimEnd().length)
    );
    // `*`, not `_`, which doesn't mark part of a word.
    const wrap = mark === "bold" ? "**" : "*";
    return {
      text: `${text.slice(0, from)}${wrap}${text.slice(from, to)}${wrap}${text.slice(to)}`,
      start: from + wrap.length,
      end: to + wrap.length,
    };
  }
  const before = text.slice(0, start);
  const after = text.slice(end);
  // A list: each selected line, or the line the cursor is on, as an item.
  const lineStart = before.lastIndexOf("\n") + 1;
  const lines = text.slice(lineStart, end).split("\n");
  const listed = lines
    .map((line, index) =>
      mark === "bullets" ? `- ${line}` : `${index + 1}. ${line}`
    )
    .join("\n");
  return {
    text: `${text.slice(0, lineStart)}${listed}${after}`,
    start: lineStart,
    end: lineStart + listed.length,
  };
};
