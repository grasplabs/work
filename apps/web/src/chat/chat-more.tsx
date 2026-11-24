import type { ChatSummary } from "@grasp-os/shared/chat";
import { chatTitleMaxLength, chatTitleSchema } from "@grasp-os/shared/chat";
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { InlineEdit } from "@grasp-os/ui/components/inline-edit";
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  FileIcon,
  FilePdfIcon,
  Icon,
  PencilIcon,
  TrashIcon,
} from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { useCopy } from "../copy.ts";
import { exportAs } from "../export/export-file.tsx";
import type { ExportFormat } from "../export/export-file.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { chatMarkdown } from "./chat-markdown.ts";
import { useFollowedChat } from "./chat-watch.ts";
import { DeleteChatDialog } from "./delete-chat-dialog.tsx";
import { FailureLine } from "./failure-line.tsx";
import type { SourceName } from "./sources.tsx";

const styles = stylex.create({
  title: {
    display: "flex",
    alignItems: "center",
    gap: space["1"],
    minWidth: 0,
  },
});

// The open chat's title at the head of the chat, renamed where it stands,
// beside its menu (Damsko's Inline edit and Dropdown menu): copy it as Markdown,
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
  const [editing, setEditing] = useState(false);
  const [failure, setFailure] = useState<string>();
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
      setFailure(undefined);
      onRenamed?.(parsed.data);
      await router.invalidate();
      return;
    }
    setFailure(t`The chat couldn't be renamed. Try again.`);
  };
  const download = async (format: ExportFormat): Promise<void> => {
    try {
      await exportAs(
        { name: fileNameOf(chat.title), title: chat.title, markdown },
        format,
        i18n.locale
      );
    } catch {
      setFailure(t`The export didn't work. Try again.`);
    }
  };
  return (
    <>
      <span {...stylex.props(styles.title)}>
        <InlineEdit
          aria-label={t`Chat name`}
          editing={editing}
          onEditingChange={setEditing}
          onSubmit={rename}
          validate={(name) =>
            name.trim().length > chatTitleMaxLength
              ? t`A chat's name is at most ${chatTitleMaxLength} characters.`
              : undefined
          }
          value={chat.title}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={t`More for this chat`}
              size="icon-sm"
              variant="ghost"
            >
              <Icon icon={EllipsisIcon} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {/* It stays open for a moment to say that it is copied. */}
            <DropdownMenuItem
              closeOnSelect={false}
              disabled={!ready}
              icon={copied ? CheckIcon : CopyIcon}
              onSelect={() => {
                void copy(markdown());
              }}
            >
              {copied ? <Trans>Copied</Trans> : <Trans>Copy as Markdown</Trans>}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={!ready} icon={DownloadIcon}>
                <Trans>Download</Trans>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem
                  icon={FileIcon}
                  onSelect={() => {
                    void download("md");
                  }}
                >
                  <Trans>Markdown (.md)</Trans>
                </DropdownMenuItem>
                <DropdownMenuItem
                  icon={FilePdfIcon}
                  onSelect={() => {
                    void download("pdf");
                  }}
                >
                  <Trans>PDF</Trans>
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              icon={PencilIcon}
              onSelect={() => {
                setEditing(true);
              }}
            >
              <Trans>Rename</Trans>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              icon={TrashIcon}
              onSelect={() => {
                onDeleting(true);
              }}
              variant="destructive"
            >
              <Trans>Delete</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      <FailureLine>{failure}</FailureLine>
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
