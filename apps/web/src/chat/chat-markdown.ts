import type {
  ChatMessage,
  ChatPartial,
  ChatProvenance,
} from "@grasp-os/shared/chat";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { SourceName } from "./sources.tsx";

// A chat as Markdown, for its export (export/export-menu.tsx): its title,
// each question and answer in turn with how each answer ended, and the
// sources its answers draw on, marked restricted where the chat is. What
// the agent's code returned stays out, as it does in the thread unless
// opened: the answers say what came of it.

/** Characters Markdown would read as syntax in what someone typed. */
const markdownSyntax = /[\\`*_[\]#|<>~]/gu;

/** A list marker or a numbered one at the start of a line. */
const lineMarker = /^(?<indent>\s*)(?<marker>[-+]|\d+\.)(?<space>\s)/gmu;

/**
 * A question as its asker typed it: plain text, its line breaks kept, as
 * the thread shows it, never read as Markdown.
 */
export const plainText = (text: string): string =>
  text
    .replaceAll(markdownSyntax, String.raw`\$&`)
    .replaceAll(lineMarker, String.raw`$<indent>\$<marker>$<space>`)
    .replaceAll("\n", "\\\n");

/** How an answer ended, as the thread says it, if it says anything. */
const endNote = (
  reply: Extract<ChatMessage, { role: "assistant" }>,
  i18n: I18n
): string | undefined => {
  switch (reply.end) {
    case "cancelled": {
      return i18n._(msg`Stopped.`);
    }
    case "cut_off": {
      return i18n._(msg`The answer was cut off at the model's limit.`);
    }
    case "failed": {
      return reply.error ?? i18n._(msg`The model call failed.`);
    }
    case "done": {
      return undefined;
    }
    default: {
      return undefined;
    }
  }
};

/** One question or answer: who, on a line of its own, then what. */
const turnOf = (message: ChatMessage, i18n: I18n): string | undefined => {
  if (message.role === "result") {
    return undefined;
  }
  if (message.role === "user") {
    const label = i18n._(
      msg({ message: "**You:**", comment: "Who asked, in an exported chat." })
    );
    return `${label}\n\n${plainText(message.text.trim())}`;
  }
  const parts = [message.text.trim(), endNote(message, i18n)].filter(
    (part): part is string => part !== undefined && part !== ""
  );
  if (parts.length === 0) {
    return undefined;
  }
  const label = i18n._(
    msg({
      message: "**Grasp:**",
      comment: "Who answered, in an exported chat.",
    })
  );
  return [label, ...parts].join("\n\n");
};

/**
 * The chat titled `title` as Markdown. `names` names its sources as the
 * page does; one it doesn't know keeps its ID.
 */
export const chatMarkdown = ({
  title,
  messages,
  partial = null,
  provenance,
  names,
  i18n,
}: {
  title: string;
  messages: readonly ChatMessage[];
  /** The answer being written now, as far as it has come, as the thread shows it. */
  partial?: ChatPartial | null;
  provenance: ChatProvenance;
  names: ReadonlyMap<string, SourceName>;
  i18n: I18n;
}): string => {
  const writing =
    partial === null || partial.text.trim() === ""
      ? []
      : [
          {
            id: Number.MAX_SAFE_INTEGER,
            role: "assistant" as const,
            text: partial.text,
            code: [],
            end: "done" as const,
            at: "",
          },
        ];
  const turns = [...messages, ...writing].flatMap((message) => {
    const turn = turnOf(message, i18n);
    return turn === undefined ? [] : [turn];
  });
  const sources = provenance.sources.map(
    (id) => `- ${plainText(names.get(id)?.name ?? id)}`
  );
  // What the answers draw on: restricted data first, as the chat marks it.
  const footer = [
    ...(provenance.restricted ? [`**${i18n._(msg`Restricted`)}**`] : []),
    ...(sources.length === 0 ? [] : [sources.join("\n")]),
  ];
  return [
    `# ${plainText(title)}`,
    ...turns,
    ...(footer.length === 0 ? [] : [`## ${i18n._(msg`Sources`)}`, ...footer]),
  ].join("\n\n");
};
