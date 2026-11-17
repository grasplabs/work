import { chatFileTypes } from "@grasp-os/shared/chat";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { formatBytes } from "../format.ts";
import { ComposerAttachment } from "../grasp/composer/index.ts";
import type { ComposerAttachmentWords } from "../grasp/composer/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// Files attached to a question (grasplabs/prototype's chat attachments):
// the picker the composer's add menu opens, each one's card in the box before it is
// sent, and under the question once it is. Core takes the types
// `chatFileTypes` names; the box checks the rest (use-ask.ts).

/** What the file picker offers: the extensions core takes. */
export const accepted = Object.keys(chatFileTypes)
  .map((extension) => `.${extension}`)
  .join(",");

/** A file as its card shows it. */
export interface CardFile {
  id: string;
  name: string;
  bytes: number;
}

const styles = stylex.create({
  cards: {
    display: "flex",
    flexWrap: "wrap",
    gap: grasp.space2,
  },
});

/**
 * The words of a file's card, in the page's language: `waiting` in the box,
 * where a file goes up only once the question is sent, and `sent` under a
 * question that carried it.
 */
export const useAttachmentWords = (
  where: "waiting" | "sent"
): ComposerAttachmentWords => {
  const { t } = useLingui();
  return {
    uploading: t`Uploading`,
    done: where === "waiting" ? t`Ready to send` : t`Sent`,
    failed: t`Could not upload`,
    retry: t`Try again`,
    remove: t`Remove`,
    size: formatBytes,
    pages: (count) => plural(count, { one: "# page", other: "# pages" }),
  };
};

/** The cards of a question's files, as Grasp UI's Composer draws them; in the box, each with a way to take it off. */
export const FileCards = ({
  files,
  onRemove,
}: {
  files: readonly CardFile[];
  onRemove?: (id: string) => void;
}) => {
  const { t } = useLingui();
  const words = useAttachmentWords(onRemove === undefined ? "sent" : "waiting");
  return (
    <ul aria-label={t`Attached files`} {...stylex.props(styles.cards)}>
      {files.map((file) => (
        <li key={file.id}>
          <ComposerAttachment
            name={file.name}
            onRemove={
              onRemove === undefined
                ? undefined
                : () => {
                    onRemove(file.id);
                  }
            }
            size={file.bytes}
            words={words}
          />
        </li>
      ))}
    </ul>
  );
};
