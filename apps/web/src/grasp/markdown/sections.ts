import type { Placed } from "./blocks";
// A collapsible section in Markdown, in the one form GitHub renders and DocumentEditor writes:
//
//   <details>                                (or with attributes: `<details open>` stands open)
//   <summary>The policy's limits</summary>
//
//   - Meals: €40 a day.
//
//   </details>
//
// CommonMark reads that as three things: an HTML block holding the opening and the summary, the
// Markdown blocks of its body, and an HTML block holding the closing. Markdown draws raw HTML as text
// and never as HTML; only this form is read again here, as a section with its summary and the
// blocks between. Any other HTML stays text. An opening with no closing yet (an answer still being
// written) stays text too, until its closing arrives, so nothing is drawn as a section and then
// taken back. Sections may hold sections.
import { parse } from "./parse";
import type { PhrasingContent } from "./types";

/** An opening: `<details>`, then its `<summary>` on the next line or the same one, and nothing after. */
const OPENING =
  /^<details(?<attributes>(?:\s+[a-z][a-z-]*(?:="[^"\n]*")?)*)\s*>[ \t]*\n?[ \t]*<summary>(?<summary>[^\n]*?)<\/summary>[ \t]*$/u;
const CLOSING = /^<\/details>[ \t]*$/u;

/** One block of the answer, or a section holding its own. */
export type Drawn =
  | { kind: "block"; placed: Placed }
  | {
      kind: "section";
      summary: PhrasingContent[];
      summaryText: string;
      open: boolean;
      children: Drawn[];
      key: Placed;
    };

const htmlOf = (placed: Placed): string | null =>
  placed.node.type === "html" ? placed.node.value.trim() : null;

/** The summary's words, read as Markdown's inline text (bold, code, links), as GitHub reads them. */
const summaryOf = (text: string): PhrasingContent[] => {
  const [first] = parse(text).children;
  return first?.type === "paragraph" ? first.children : [];
};

/** Where the section opened at `from` closes, counting the sections inside it; -1 if it does not. */
const closingOf = (blocks: readonly Placed[], from: number): number => {
  let depth = 0;
  for (const [offset, block] of blocks.slice(from + 1).entries()) {
    const html = htmlOf(block);
    if (html !== null && OPENING.test(html)) {
      depth += 1;
    } else if (html !== null && CLOSING.test(html)) {
      if (depth === 0) {
        return from + 1 + offset;
      }
      depth -= 1;
    }
  }
  return -1;
};

/** The answer's blocks, with every whole section read as one. */
export const groupSections = (blocks: readonly Placed[]): Drawn[] => {
  const drawn: Drawn[] = [];
  let at = 0;
  while (at < blocks.length) {
    const block = blocks[at];
    if (block === undefined) {
      break;
    }
    const opening = OPENING.exec(htmlOf(block) ?? "");
    const end = opening === null ? -1 : closingOf(blocks, at);
    if (opening === null || end === -1) {
      drawn.push({ kind: "block", placed: block });
      at += 1;
    } else {
      const summaryText = (opening.groups?.summary ?? "").trim();
      // `<details open>` stands open at first, as GitHub draws it (an Ask block is written so).
      const open = /(?:^|\s)open(?:\s|=|$)/u.test(
        opening.groups?.attributes ?? ""
      );
      drawn.push({
        kind: "section",
        summary: summaryOf(summaryText),
        summaryText,
        open,
        children: groupSections(blocks.slice(at + 1, end)),
        key: block,
      });
      at = end + 1;
    }
  }
  return drawn;
};
