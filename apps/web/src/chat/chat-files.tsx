import { chatFileTypes } from "@grasp-os/shared/chat";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@grasp-os/ui/components/attachment";
import { Icon, XIcon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";

import { formatBytes } from "../format.ts";

// Files attached to a question (grasplabs/prototype's chat attachments):
// each one's card in the box before it is sent, and under the question
// once it is. Core takes the types `chatFileTypes` names; the page checks
// every file the box hands it against them, and says why one stays out
// (use-ask.ts).

/** A file's media type, as core takes it by its extension; none for one it doesn't name. */
const typeOf = (name: string): string | undefined => {
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  return Object.entries(chatFileTypes).find(
    ([known]) => known === extension
  )?.[1];
};

/** A file as its card shows it. */
export interface CardFile {
  id: string;
  name: string;
  bytes: number;
}

/** One file's card: its name and size, and, in the box, a way to take it off. */
const FileCard = ({
  file,
  onRemove,
}: {
  file: CardFile;
  onRemove?: (id: string) => void;
}) => {
  const { t } = useLingui();
  const { name } = file;
  return (
    <Attachment size="sm">
      <AttachmentMedia type={typeOf(name)} />
      <AttachmentContent>
        <AttachmentTitle>{name}</AttachmentTitle>
        <AttachmentDescription>{formatBytes(file.bytes)}</AttachmentDescription>
      </AttachmentContent>
      {onRemove === undefined ? null : (
        <AttachmentActions>
          <AttachmentAction
            aria-label={t`Remove ${name}`}
            onClick={() => {
              onRemove(file.id);
            }}
          >
            <Icon icon={XIcon} />
          </AttachmentAction>
        </AttachmentActions>
      )}
    </Attachment>
  );
};

/** The cards of a question's files: in the box, each with a way to take it off. */
export const FileCards = ({
  files,
  onRemove,
}: {
  files: readonly CardFile[];
  onRemove?: (id: string) => void;
}) => {
  const { t } = useLingui();
  return (
    <AttachmentGroup aria-label={t`Files`}>
      {files.map((file) => (
        <FileCard file={file} key={file.id} onRemove={onRemove} />
      ))}
    </AttachmentGroup>
  );
};
