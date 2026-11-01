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
import { PromptInputButton } from "@grasp-os/ui/components/prompt-input";
import { useLingui } from "@lingui/react/macro";
import { FileTextIcon, PaperclipIcon, XIcon } from "lucide-react";
import { useRef } from "react";

import { formatBytes } from "../format.ts";

// Files attached to a question (grasplabs/prototype's chat attachments):
// the button that picks them, each one's card in the box before it is
// sent, and under the question once it is. Core takes the types
// `chatFileTypes` names; the box checks the rest (use-ask.ts).

/** What the file picker offers: the extensions core takes. */
const accepted = Object.keys(chatFileTypes)
  .map((extension) => `.${extension}`)
  .join(",");

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
      <AttachmentMedia>
        <FileTextIcon />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle title={name}>{name}</AttachmentTitle>
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
            <XIcon />
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
}) => (
  <AttachmentGroup>
    {files.map((file) => (
      <FileCard file={file} key={file.id} onRemove={onRemove} />
    ))}
  </AttachmentGroup>
);

/** Picks files to attach to the question being written. */
export const AttachFiles = ({
  onAttach,
  disabled,
}: {
  onAttach: (files: readonly File[]) => void;
  disabled: boolean;
}) => {
  const { t } = useLingui();
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        accept={accepted}
        aria-hidden="true"
        className="hidden"
        multiple
        onChange={(event) => {
          onAttach([...(event.target.files ?? [])]);
          // The same file can be picked again once it was taken off.
          event.target.value = "";
        }}
        ref={input}
        tabIndex={-1}
        type="file"
      />
      <PromptInputButton
        disabled={disabled}
        onClick={() => {
          input.current?.click();
        }}
        tooltip={t`Attach files`}
      >
        <PaperclipIcon />
      </PromptInputButton>
    </>
  );
};
