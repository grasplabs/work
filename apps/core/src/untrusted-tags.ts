import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { randomToken } from "@grasp-os/shared/encoding";

// The tags that mark what a run read from outside Grasp as data
// (code-mode.ts `describeRun`), and the model's answers without them. The
// model reads the tags as they are; a model that copies one into its
// answer must not show it to the person, in the chat or anywhere its
// answer goes (`withoutUntrustedTagsIn`).

/** The random bytes of a tag's ID: 128 bits, which no text can guess. */
const idBytes = 16;

/** The ID's characters: unpadded base64url of {@link idBytes}. */
const idLength = Math.ceil((idBytes * 4) / 3);

const prefix = "untrusted-";

/** An opening or closing tag of the marking, exactly as it is drawn. */
const tagPattern = new RegExp(`</?${prefix}[\\w-]{${idLength}}>`, "gu");

/** The ID's characters, none or more. */
const idCharacters = /^[\w-]*$/u;

/** A tag's name for one run's marking: a new ID each time. */
export const untrustedTag = (): string => `${prefix}${randomToken(idBytes)}`;

/**
 * Whether `tail`, from a `<` to the end of the text, could still become a
 * tag of the marking as more text comes.
 */
const mayBecomeTag = (tail: string): boolean => {
  const name = tail.slice(tail.startsWith("</") ? 2 : 1);
  if (name.length <= prefix.length) {
    return prefix.startsWith(name);
  }
  return (
    name.startsWith(prefix) &&
    name.length <= prefix.length + idLength &&
    idCharacters.test(name.slice(prefix.length))
  );
};

/**
 * `text` without the marking's tags, and the text between them kept.
 * While more of it is to come (`more`), a tag's beginning at its end is
 * held back until the rest shows whether it is one. Shown so far, the
 * text only grows: each result begins with the one before it.
 */
export const withoutUntrustedTags = (text: string, more = false): string => {
  const last = text.lastIndexOf("<");
  if (last === -1) {
    return text;
  }
  const end = more && mayBecomeTag(text.slice(last)) ? last : text.length;
  return text.slice(0, end).replace(tagPattern, "");
};

/**
 * `message` with its text without the marking's tags, the text of block
 * `streaming` held back as more of it is to come. Always a copy of its
 * text blocks: a provider keeps writing to the partial it streams.
 */
const shownMessage = (
  message: AssistantMessage,
  streaming?: number
): AssistantMessage => ({
  ...message,
  content: message.content.map((part, index) =>
    part.type === "text"
      ? { ...part, text: withoutUntrustedTags(part.text, index === streaming) }
      : part
  ),
});

/**
 * The model's answer as `source` streams it, without the marking's tags:
 * its partials, deltas and final message, so what pi stores and shows, and
 * all that is made of it, never holds them. A text block's deltas add up
 * to its text as shown, the beginning of a tag held back until the rest
 * shows whether it is one, and let go when it isn't.
 */
export const withoutUntrustedTagsIn = (
  source: AssistantMessageEventStream
): AssistantMessageEventStream => {
  const out = createAssistantMessageEventStream();
  /** How much of each text block the deltas sent so far. */
  const sent = new Map<number, number>();
  const textTo = (
    index: number,
    partial: AssistantMessage
  ): AssistantMessageEvent[] => {
    const block = partial.content[index];
    const text = block?.type === "text" ? block.text : "";
    const from = sent.get(index) ?? 0;
    sent.set(index, text.length);
    return text.length > from
      ? [
          {
            type: "text_delta",
            contentIndex: index,
            delta: text.slice(from),
            partial,
          },
        ]
      : [];
  };
  const shown = (event: AssistantMessageEvent): AssistantMessageEvent[] => {
    if (event.type === "done") {
      return [{ ...event, message: shownMessage(event.message) }];
    }
    if (event.type === "error") {
      return [{ ...event, error: shownMessage(event.error) }];
    }
    if (event.type === "text_start") {
      sent.set(event.contentIndex, 0);
      return [
        { ...event, partial: shownMessage(event.partial, event.contentIndex) },
      ];
    }
    if (event.type === "text_delta") {
      return textTo(
        event.contentIndex,
        shownMessage(event.partial, event.contentIndex)
      );
    }
    if (event.type === "text_end") {
      const partial = shownMessage(event.partial);
      return [
        ...textTo(event.contentIndex, partial),
        { ...event, content: withoutUntrustedTags(event.content), partial },
      ];
    }
    return [{ ...event, partial: shownMessage(event.partial) }];
  };
  void (async () => {
    for await (const event of source) {
      for (const each of shown(event)) {
        out.push(each);
      }
    }
    out.end();
  })();
  return out;
};
