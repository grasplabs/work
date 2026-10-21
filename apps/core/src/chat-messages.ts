import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import { chatCitationsMax } from "@grasp-os/shared/chat";
import type {
  ChatCitation,
  ChatCode,
  ChatMessage,
  ChatPartial,
  ChatReplyEnd,
  ChatReplyUsage,
} from "@grasp-os/shared/chat";

import { contextWindowOf } from "./models.ts";

// A chat's transcript as pi keeps it (workspace.ts), shown as the person
// reads it: their questions, the agent's answers with the code it ran,
// and each code step's result. The agent's instructions, the APIs and the
// memory it was shown, and its reasoning stay out.

/** The text parts of a message's content, joined. */
const textOf = (
  content: string | readonly { type: string; text?: string }[]
): string =>
  typeof content === "string"
    ? content
    : content
        .flatMap((part) =>
          part.type === "text" && typeof part.text === "string"
            ? [part.text]
            : []
        )
        .join("");

/**
 * The code a response asked to run: each `executeCode` call's code, as far
 * as it has streamed in (pi parses the call's arguments as they come).
 */
const codeOf = (message: AssistantMessage): ChatCode[] =>
  message.content.flatMap((part) => {
    if (part.type !== "toolCall") {
      return [];
    }
    const { code } = part.arguments;
    return [{ callId: part.id, code: typeof code === "string" ? code : "" }];
  });

const ends: Record<AssistantMessage["stopReason"], ChatReplyEnd> = {
  stop: "done",
  toolUse: "done",
  // Neither ends a response this loop keeps; shown as done if one did.
  pending: "done",
  deferred: "done",
  length: "cut_off",
  aborted: "cancelled",
  error: "failed",
};

/** The provider core names its own messages by (workspace.ts). */
const coreProvider = "grasp";

/** Whether `usage` counts nothing at all: a request that used nothing. */
const usedNothing = ({ input, output, cacheRead, cacheWrite, cost }: Usage) =>
  input + output + cacheRead + cacheWrite === 0 && cost.total === 0;

/**
 * What a reply used, as the gateway counted it (models.ts prices its cost
 * as the budgets are charged); none for core's own words, nor for a reply
 * that used nothing (refused or failed before the provider took it).
 */
const usageOf = ({
  provider,
  model,
  usage,
}: AssistantMessage): ChatReplyUsage | undefined =>
  provider === coreProvider || usedNothing(usage)
    ? undefined
    : {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        cost: usage.cost.total,
        contextWindow: contextWindowOf(model) ?? null,
      };

/**
 * An inline Markdown link to a note: its text, and the note's ID, its
 * destination in angle brackets or not, with a title or none. Only this
 * form, in lower case and with an ID of plain characters, is ever kept.
 */
const noteLink =
  /\[(?<label>[^\]\n]*)\]\(\s*<?grasp:note\/(?<id>[\w-]{1,128})>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/gu;

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
 * What stands for a kept link while the rest of the text is cleaned: a
 * private-use character (U+E000) around the link's place, which no answer
 * keeps.
 */
const mark = String.fromCodePoint(0xe0_00);

const keptMark = (index: number): string => `${mark}${index}${mark}`;

const keptMarks = new RegExp(`${mark}(?<index>\\d+)${mark}`, "gu");

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
 * An answer's text with the notes it cites (`ChatCitation`): its links to
 * the first {@link chatCitationsMax} notes `given` holds stay, each as
 * `[label](grasp:note/<id>)`, and are its citations. Everything else
 * outside code loses the note scheme, wherever and however it is written:
 * a link to any other note is its text alone, and an autolink, a reference
 * definition, an escaped or character-referenced scheme, or one in another
 * case or nested in itself is left without it. Code renders as it is
 * written, never as a link, so it stays as it is and cites nothing. So the
 * answer's only note links are its citations, whatever the model wrote.
 */
export const citedIn = (
  text: string,
  given: (documentId: string) => boolean
): { text: string; citations: ChatCitation[] } => {
  const cited: string[] = [];
  const cleaned = (prose: string): string => {
    const kept: string[] = [];
    const marked = prose
      .replaceAll(mark, "")
      .replaceAll(characterReference, "&amp;")
      .replaceAll(escapedPunctuation, "$<character>")
      .replaceAll(noteLink, (_link, label: string, id: string) => {
        const known = cited.includes(id);
        if (!given(id) || (!known && cited.length >= chatCitationsMax)) {
          return label;
        }
        if (!known) {
          cited.push(id);
        }
        kept.push(`[${withoutScheme(label)}](grasp:note/${id})`);
        return keptMark(kept.length - 1);
      });
    return withoutScheme(marked).replaceAll(
      keptMarks,
      (_mark, index: string) => kept[Number(index)] ?? ""
    );
  };
  return {
    text: partsOf(text)
      .map((part) => (part.code ? part.text : cleaned(part.text)))
      .join(""),
    citations: cited.map((documentId) => ({ kind: "document", documentId })),
  };
};

/** Cites nothing: every note link shows as its text. */
const givenNothing = (): boolean => false;

/**
 * A response being written, as the person sees it so far: with no note
 * link yet, each its text alone (`citedIn`, citing nothing), since what a
 * note link may cite is decided only once the answer is stored.
 */
export const partialOf = (message: AssistantMessage): ChatPartial => ({
  text: citedIn(textOf(message.content), givenNothing).text,
  code: codeOf(message),
});

/**
 * A stored message as the person reads it; `undefined` for a system one.
 * An answer cites the notes `given` holds (`citedIn`): the documents its
 * chat's code was given before it.
 */
export const chatMessageOf = (
  id: number,
  message: Message,
  createdAt: Date,
  given: (documentId: string) => boolean = givenNothing
): ChatMessage | undefined => {
  const at = createdAt.toISOString();
  if (message.role === "user") {
    return { id, role: "user", text: textOf(message.content), at };
  }
  if (message.role === "assistant") {
    const usage = usageOf(message);
    return {
      id,
      role: "assistant",
      ...citedIn(textOf(message.content), given),
      code: codeOf(message),
      end: ends[message.stopReason],
      ...(message.stopReason === "error" && message.errorMessage !== undefined
        ? { error: message.errorMessage }
        : {}),
      ...(usage === undefined ? {} : { usage }),
      at,
    };
  }
  if (message.role === "toolResult") {
    return {
      id,
      role: "result",
      callId: message.toolCallId,
      text: textOf(message.content),
      failed: message.isError,
      at,
    };
  }
  return undefined;
};
