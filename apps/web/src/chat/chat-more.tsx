import type { ChatSummary } from "@grasp-os/shared/chat";
import { chatTitleSchema } from "@grasp-os/shared/chat";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { useCopy } from "../copy.ts";
import { exportAs } from "../export/export-file.tsx";
import type { ExportFormat } from "../export/export-file.tsx";
import { AppShellPanelTitle } from "../grasp/app-shell/index.ts";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import {
  Copy,
  Doc,
  Edit,
  More,
  Pdf,
  Tick,
  Trash,
} from "../grasp/icons/index.ts";
import { toast } from "../grasp/toast/index.ts";
import { useCoreAction } from "../use-core-action.ts";
import { chatMarkdown } from "./chat-markdown.ts";
import { useFollowedChat } from "./chat-watch.ts";
import { DeleteChatDialog } from "./delete-chat-dialog.tsx";
import type { SourceName } from "./sources.tsx";

// The open chat at the head of its panel (chat-panel.tsx): its name,
// renamed where it stands (App shell's panel title: a double-click, F2 or
// Enter), and its menu: copy it as Markdown, download it as Markdown or
// PDF, and delete it. Its row in the list of chats does the same, but here
// it is where the chat is read, and nothing lies over the messages.

/** Characters a file name can't hold on some system, and runs of space. */
const unsafeInFileName = /[\s"*/:<>?\\|]+/gu;

/** The name a chat downloads under: its title, made safe for a file. */
const fileNameOf = (title: string): string =>
  title
    .replaceAll(unsafeInFileName, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 80) || "grasp-chat";

/**
 * Renames chat `chatId` to a new name, trimmed, and reads the page again;
 * `onRenamed` shows the new name at once. Where core can't, it says so.
 */
export const useRenameChat = (
  chatId: string,
  onRenamed?: (title: string) => void
): ((name: string) => void) => {
  const { t } = useLingui();
  const router = useRouter();
  const { run } = useCoreAction();
  const rename = async (name: string): Promise<void> => {
    const parsed = chatTitleSchema.safeParse(name);
    const renamed =
      parsed.success &&
      (await run(async (session) => {
        await session.chats.rename(chatId, parsed.data);
        return true;
      }));
    if (renamed === true && parsed.success) {
      onRenamed?.(parsed.data);
      await router.invalidate();
      return;
    }
    toast.error(t`The chat couldn't be renamed. Try again.`);
  };
  return (name) => {
    void rename(name);
  };
};

/** The open chat's name at the head of its panel, renamed where it stands. */
export const ChatPanelTitle = ({
  chat,
  onRenamed,
}: {
  chat: ChatSummary;
  onRenamed?: (title: string) => void;
}) => {
  const rename = useRenameChat(chat.id, onRenamed);
  return (
    <AppShellPanelTitle onRename={rename}>{chat.title}</AppShellPanelTitle>
  );
};

/**
 * The open chat's menu. `sourceNames` name where its answers came from in
 * what it copies and downloads.
 */
export const ChatMoreMenu = ({
  chat,
  sourceNames,
  onRename,
}: {
  chat: ChatSummary;
  sourceNames: ReadonlyMap<string, SourceName>;
  /** Opens the rename where the chat's name stands, where it can be opened from here. */
  onRename?: () => void;
}) => {
  const { i18n, t } = useLingui();
  // The same watch the thread reads, so what is copied is what is shown.
  const { view } = useFollowedChat(chat.id);
  const { copied, copy } = useCopy();
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
  const download = async (format: ExportFormat): Promise<void> => {
    try {
      await exportAs(
        { name: fileNameOf(chat.title), title: chat.title, markdown },
        format,
        i18n.locale
      );
    } catch {
      toast.error(t`The export didn't work. Try again.`);
    }
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t`More for this chat`}
          icon={More}
          size="sm"
          variant="ghost"
        />
        <DropdownMenuContent align="end">
          {/* It stays open for a moment to say that it is copied. */}
          <DropdownMenuItem
            closeOnSelect={false}
            disabled={!ready}
            icon={copied ? Tick : Copy}
            onSelect={() => {
              void copy(markdown());
            }}
          >
            {copied ? t`Copied` : t`Copy as Markdown`}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!ready}
            icon={Doc}
            onSelect={() => {
              void download("md");
            }}
          >
            {t`Download as Markdown`}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!ready}
            icon={Pdf}
            onSelect={() => {
              void download("pdf");
            }}
          >
            {t`Download as PDF`}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {onRename === undefined ? null : (
            <DropdownMenuItem icon={Edit} onSelect={onRename}>
              {t`Rename`}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            variant="danger"
            icon={Trash}
            onSelect={() => {
              onDeleting(true);
            }}
          >
            {t`Delete`}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
