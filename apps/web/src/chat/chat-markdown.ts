import type { ChatMessage, ChatProvenance } from "@grasp-os/shared/chat";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { SourceName } from "./sources.tsx";

// A chat as Markdown, for its export (export/export-menu.tsx): its title,
// each question and answer in turn, and the sources its answers draw on.
// What the agent's code returned stays out, as it does in the thread
// unless opened: the answers say what came of it.

/**
 * The chat titled `title` as Markdown. `names` names its sources as the
 * page does; one it doesn't know keeps its ID.
 */
export const chatMarkdown = ({
  title,
  messages,
  provenance,
  names,
  i18n,
}: {
  title: string;
  messages: readonly ChatMessage[];
  provenance: ChatProvenance;
  names: ReadonlyMap<string, SourceName>;
  i18n: I18n;
}): string => {
  const turns = messages.flatMap((message) => {
    const text = message.text.trim();
    if (message.role === "result" || text === "") {
      return [];
    }
    return message.role === "user"
      ? [
          i18n._(
            msg({
              message: `**You:** ${text}`,
              comment: "One question in an exported chat, in Markdown.",
            })
          ),
        ]
      : [
          i18n._(
            msg({
              message: `**Grasp:** ${text}`,
              comment: "One answer in an exported chat, in Markdown.",
            })
          ),
        ];
  });
  const sources = provenance.sources.map(
    (id) => `- ${names.get(id)?.name ?? id}`
  );
  const sourcesHeading = i18n._(msg`Sources`);
  return [
    `# ${title}`,
    ...turns,
    ...(sources.length === 0
      ? []
      : [`## ${sourcesHeading}\n\n${sources.join("\n")}`]),
  ].join("\n\n");
};
