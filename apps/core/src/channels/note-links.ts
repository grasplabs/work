// What a chat app's answer keeps of a note link (`[words](grasp:note/<id>
// "title")`), as Grasp's answers wrote them to cite a Knowledge document:
// its words alone, whatever its title's quoting, and no note scheme left
// anywhere outside code, however it is spelled. Moved here from the chat's
// citations (chat-messages.ts), which went with Knowledge (GRA-1735), so
// a chat app's answer still shows no note link; the general hardening of
// links in chat apps' answers is GRA-1914.

/**
 * An inline Markdown link to a note: its text, and the note's ID, its
 * destination in angle brackets or not, with a title or none, which is
 * the words of the note it quotes.
 */
const noteLink =
  /\[(?<label>[^\]\n]*)\]\(\s*<?grasp:note\/(?<id>[\w-]{1,128})>?(?:\s+(?:"(?<double>[^"\n]*)"|'(?<single>[^'\n]*)'|\((?<parenthesised>[^)\n]*)\)))?\s*\)/gu;

/**
 * A character reference a Markdown renderer would read as a character
 * (`&#58;`, `&#x3a;`), or as the scheme's own punctuation (`&colon;`,
 * `&sol;`): kept as text, so none of them can spell the note scheme.
 */
const characterReference = /&(?=#\d{1,8};|#x[\da-f]{1,8};|colon;|sol;)/giu;

/** A backslash escape of the scheme's punctuation, which renders as it. */
const escapedPunctuation = /\\(?<character>[:/])/gu;

/** The note scheme, in any case. */
const noteScheme = /grasp:note\//giu;

/**
 * `text` with no note scheme left in it, in any case, however often it
 * is nested (`grasp:grasp:note/note/`): removed until none is.
 */
const withoutScheme = (text: string): string => {
  let cleaned = text;
  while (noteScheme.test(cleaned)) {
    noteScheme.lastIndex = 0;
    cleaned = cleaned.replaceAll(noteScheme, "");
  }
  noteScheme.lastIndex = 0;
  return cleaned;
};

/**

/** A line that opens a fenced code block: its fence, and what follows it. */
const fenceOpening = /^ {0,3}(?<fence>`{3,}|~{3,})(?<info>.*)$/u;

/** A line that closes a fenced code block: its fence alone. */
const fenceClosing = /^ {0,3}(?<fence>`{3,}|~{3,})[ \t]*$/u;

/** A blank line: where a paragraph, and so a code span, ends. */
const blankLine = /\n[ \t]*\n/u;

/** A part of an answer: code, which renders as it is written, or not. */
interface Part {
  code: boolean;
  text: string;
}

/** Whether the backtick at `index` of `text` is escaped by a backslash. */
const escapedAt = (text: string, index: number): boolean => {
  let backslashes = 0;
  for (let at = index - 1; at >= 0 && text[at] === "\\"; at -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
};

/** The runs of backticks in `text`: where each starts, and how long it is. */
const backtickRuns = (text: string): { at: number; length: number }[] =>
  [...text.matchAll(/`+/gu)].map(({ index, 0: run }) => ({
    at: index,
    length: run.length,
  }));

/**
 * `text`, outside fenced code, as its code spans and the rest: a span
 * from a backtick run nothing escapes to the next run of the same length,
 * within its paragraph, as CommonMark reads one. Where that is unsure the
 * text counts as not code, which is cleaned.
 */
const spansOf = (text: string): Part[] => {
  const parts: Part[] = [];
  const runs = backtickRuns(text);
  let from = 0;
  for (let index = 0; index < runs.length; index += 1) {
    const open = runs[index];
    if (open === undefined || open.at < from || escapedAt(text, open.at)) {
      continue;
    }
    const close = runs.find(
      (run, other) => other > index && run.length === open.length
    );
    if (close !== undefined && !blankLine.test(text.slice(open.at, close.at))) {
      parts.push(
        { code: false, text: text.slice(from, open.at) },
        { code: true, text: text.slice(open.at, close.at + close.length) }
      );
      from = close.at + close.length;
      index = runs.indexOf(close);
    }
  }
  parts.push({ code: false, text: text.slice(from) });
  return parts;
};

/**
 * An answer as its code (fenced blocks and code spans) and the rest: code
 * renders as it is written, never as a link, so only the rest is cleaned.
 * A fence never closed runs to the end, as it renders.
 */
const partsOf = (text: string): Part[] => {
  const parts: Part[] = [];
  let prose: string[] = [];
  let fence: string | undefined;
  for (const line of text.split(/(?<=\n)/u)) {
    const bare = line.replace(/\r?\n$/u, "");
    if (fence === undefined) {
      const opening = fenceOpening.exec(bare)?.groups;
      const opens =
        opening?.fence !== undefined &&
        !(
          opening.fence.startsWith("`") &&
          (opening.info?.includes("`") ?? false)
        );
      if (opens) {
        parts.push(...spansOf(prose.join("")));
        prose = [];
        fence = opening?.fence;
        parts.push({ code: true, text: line });
      } else {
        prose.push(line);
      }
      continue;
    }
    parts.push({ code: true, text: line });
    const closing = fenceClosing.exec(bare)?.groups?.fence;
    if (
      closing !== undefined &&
      closing.startsWith(fence.slice(0, 1)) &&
      closing.length >= fence.length
    ) {
      fence = undefined;
    }
  }
  parts.push(...spansOf(prose.join("")));
  return parts;
};

/**
 * `text` with every note link as its words alone, and no note scheme left
 * outside code: what the chat's citations left of a note link they didn't
 * cite (`citedIn`, given nothing).
 */
export const notesAsWords = (text: string): string =>
  partsOf(text)
    .map(({ code, text: part }) =>
      code
        ? part
        : withoutScheme(
            part
              .replaceAll(characterReference, "&amp;")
              .replaceAll(escapedPunctuation, "$<character>")
              .replaceAll(noteLink, "$<label>")
          )
    )
    .join("");
