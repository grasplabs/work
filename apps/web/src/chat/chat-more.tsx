import type { ChatSummary } from "@grasp-os/shared/chat";
import { chatTitleMaxLength, chatTitleSchema } from "@grasp-os/shared/chat";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  EditableTitle,
  EditableTitleField,
  EditableTitleMenuContent,
  EditableTitleRenameItem,
  EditableTitleTrigger,
} from "@grasp-os/ui/components/editable-title";
import { toast } from "@grasp-os/ui/components/toast";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  FileTextIcon,
  PencilIcon,
  PrinterIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { useCopy } from "../copy.ts";
import { exportAs } from "../export/export-file.tsx";
import type { ExportFormat } from "../export/export-file.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { chatMarkdown } from "./chat-markdown.ts";
import { useFollowedChat } from "./chat-watch.ts";
import { DeleteChatDialog } from "./delete-chat-dialog.tsx";
import type { SourceName } from "./sources.tsx";

// The open chat's title at the head of the chat, renamed where it stands,
// joined to its menu (the kit's EditableTitle): copy it as Markdown,
// download it, rename it, and delete it. Its row in the list of chats does
// the same, but here it is where the chat is read, and nothing lies over
// the messages.

/** Characters a file name can't hold on some system, and runs of space. */
const unsafeInFileName = /[\s"*/:<>?\\|]+/gu;

/** The name a chat downloads under: its title, made safe for a file. */
const fileNameOf = (title: string): string =>
  title
    .replaceAll(unsafeInFileName, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 80) || "grasp-chat";

/**
 * The open chat's title and its menu. `sourceNames` name where its answers
 * came from in what it copies and downloads; `onRenamed` shows a new name
 * at once.
 */
export const ChatTitleMenu = ({
  chat,
  sourceNames,
  onRenamed,
}: {
  chat: ChatSummary;
  sourceNames: ReadonlyMap<string, SourceName>;
  onRenamed?: (title: string) => void;
}) => {
  const { i18n, t } = useLingui();
  // The same watch the thread reads, so what is copied is what is shown.
  const { view } = useFollowedChat(chat.id);
  const { copied, copy } = useCopy();
  const router = useRouter();
  const { run } = useCoreAction();
  // Which chat the delete dialog was opened for: one opened for another
  // chat, left by Back or a link while it was open, is closed, never acting
  // on this one.
  const [deletingId, setDeletingId] = useState<string>();
  const deleting = deletingId === chat.id;
  const onDeleting = (open: boolean): void => {
    setDeletingId(open ? chat.id : undefined);
  };
  // Until the chat's first update is in, there is only its title to copy.
  const ready = view.loaded;
  const markdown = (): string =>
    chatMarkdown({
      title: chat.title,
      messages: view.messages,
      partial: view.partial,
      provenance: view.provenance,
      names: sourceNames,
      i18n,
    });
  /** Renames the chat to `name`, a new one, trimmed; says so where it can't. */
  const rename = async (name: string): Promise<void> => {
    const parsed = chatTitleSchema.safeParse(name);
    const renamed =
      parsed.success &&
      (await run(async (session) => {
        await session.chats.rename(chat.id, parsed.data);
        return true;
      }));
    if (renamed === true && parsed.success) {
      onRenamed?.(parsed.data);
      await router.invalidate();
      return;
    }
    toast.add({
      type: "error",
      title: t`The chat couldn't be renamed. Try again.`,
    });
  };
  const download = async (format: ExportFormat): Promise<void> => {
    try {
      await exportAs(
        { name: fileNameOf(chat.title), title: chat.title, markdown },
        format,
        i18n.locale
      );
    } catch {
      toast.add({
        type: "error",
        title: t`The export didn't work. Try again.`,
      });
    }
  };
  return (
    <>
      <EditableTitle
        className="min-w-0"
        label={t`Chat name`}
        onValueChange={(name) => {
          void rename(name);
        }}
        value={chat.title}
      >
        <EditableTitleField maxLength={chatTitleMaxLength} />
        <DropdownMenu>
          <EditableTitleTrigger aria-label={t`More for this chat`} />
          <EditableTitleMenuContent align="start" className="w-60">
            {/* It stays open for a moment to say that it is copied. */}
            <DropdownMenuItem
              closeOnClick={false}
              disabled={!ready}
              onClick={() => {
                void copy(markdown());
              }}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? <Trans>Copied</Trans> : <Trans>Copy as Markdown</Trans>}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={!ready}>
                <DownloadIcon />
                <Trans>Download</Trans>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-44">
                <DropdownMenuItem
                  onClick={() => {
                    void download("md");
                  }}
                >
                  <FileTextIcon />
                  <Trans>Markdown (.md)</Trans>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    void download("pdf");
                  }}
                >
                  <PrinterIcon />
                  <Trans>PDF</Trans>
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <EditableTitleRenameItem>
              <PencilIcon />
              <Trans>Rename</Trans>
            </EditableTitleRenameItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                onDeleting(true);
              }}
              variant="destructive"
            >
              <Trash2Icon />
              <Trans>Delete</Trans>
            </DropdownMenuItem>
          </EditableTitleMenuContent>
        </DropdownMenu>
      </EditableTitle>
      {/* It mounts when it opens, so it starts from the chat as it is now. */}
      {deleting ? (
        <DeleteChatDialog
          active
          chat={chat}
          onOpenChange={onDeleting}
          open={deleting}
        />
      ) : null}
    </>
  );
};
