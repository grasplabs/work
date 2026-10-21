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

/** A response being written, as the person sees it so far. */
export const partialOf = (message: AssistantMessage): ChatPartial => ({
  text: textOf(message.content),
  code: codeOf(message),
});

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

/** A Markdown link to a note: its text, and the note's ID. */
const noteLink = /\[(?<label>[^\]\n]*)\]\(grasp:note\/(?<id>[^\s)]+)\)/gu;

/**
 * An answer's text with the notes it cites (`ChatCitation`): its links to
 * notes `given` holds stay, the first {@link chatCitationsMax} of them as
 * its citations; any other note link is its text alone, so an answer never
 * shows a citation of what its chat wasn't given, whatever the model wrote.
 */
export const citedIn = (
  text: string,
  given: (documentId: string) => boolean
): { text: string; citations: ChatCitation[] } => {
  const cited: string[] = [];
  const shown = text.replaceAll(noteLink, (link, label: string, id: string) => {
    if (!given(id)) {
      return label;
    }
    if (!cited.includes(id) && cited.length < chatCitationsMax) {
      cited.push(id);
    }
    return link;
  });
  return {
    text: shown,
    citations: cited.map((documentId) => ({ kind: "document", documentId })),
  };
};

/** Cites nothing: every note link shows as its text. */
const givenNothing = (): boolean => false;

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
