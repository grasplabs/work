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

/**
 * An answer's text with the notes it cites (`ChatCitation`): its links to
 * the first {@link chatCitationsMax} notes `given` holds stay, each as
 * `[label](grasp:note/<id>)`, and are its citations. Everything else loses
 * the note scheme, wherever and however it is written: a link to any other
 * note is its text alone, and an autolink, a reference definition, an
 * escaped or character-referenced scheme, or one in another case or nested
 * in itself is left without it. So the answer's only note links are its
 * citations, whatever the model wrote.
 */
export const citedIn = (
  text: string,
  given: (documentId: string) => boolean
): { text: string; citations: ChatCitation[] } => {
  const cited: string[] = [];
  const kept: string[] = [];
  const marked = text
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
  const shown = withoutScheme(marked).replaceAll(
    keptMarks,
    (_mark, index: string) => kept[Number(index)] ?? ""
  );
  return {
    text: shown,
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
