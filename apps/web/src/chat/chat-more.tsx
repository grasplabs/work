import type { ChatSummary } from "@grasp-os/shared/chat";
import { chatTitleMaxLength, chatTitleSchema } from "@grasp-os/shared/chat";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { useCopy } from "../copy.ts";
import { exportAs } from "../export/export-file.tsx";
import type { ExportFormat } from "../export/export-file.tsx";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuPanel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import { Copy, Doc, Edit, Pdf, Tick, Trash } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import { toast } from "../grasp/toast/index.ts";
import { useCoreAction } from "../use-core-action.ts";
import { chatMarkdown } from "./chat-markdown.ts";
import { useFollowedChat } from "./chat-watch.ts";
import { DeleteChatDialog } from "./delete-chat-dialog.tsx";
import type { SourceName } from "./sources.tsx";

// The open chat's title at the head of the chat, which opens its menu:
// copy it as Markdown, download it as Markdown or PDF, rename it where it
// stands, and delete it. Its row in the list of chats does
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
 * The chat's name, typed where its title stood: Enter or leaving the field
 * keeps it, Escape keeps the name as it was.
 */
const RenameTitle = ({
  value,
  onDone,
}: {
  value: string;
  /** The name typed, or none where it was left as it was. */
  onDone: (name?: string) => void;
}) => {
  const { t } = useLingui();
  const [name, setName] = useState(value);
  return (
    <Input
      aria-label={t`Chat name`}
      autoFocus
      maxLength={chatTitleMaxLength}
      onBlur={() => {
        onDone(name);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onDone(name);
        } else if (event.key === "Escape") {
          event.preventDefault();
          onDone();
        }
      }}
      onValueChange={(next) => {
        setName(next);
      }}
      size="sm"
      value={name}
    />
  );
};

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
  // Renaming this chat: another chat opened meanwhile is never renamed.
  const [renamingId, setRenamingId] = useState<string>();
  const renaming = renamingId === chat.id;
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
    toast.error(t`The chat couldn't be renamed. Try again.`);
  };
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
      {renaming ? (
        <RenameTitle
          key={chat.id}
          onDone={(name) => {
            setRenamingId(undefined);
            if (name !== undefined && name.trim() !== chat.title) {
              void rename(name);
            }
          }}
          value={chat.title}
        />
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t`More for this chat`}
            chevron
            size="sm"
            variant="ghost"
          >
            {chat.title}
          </DropdownMenuTrigger>
          <DropdownMenuPanel align="start">
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
            <DropdownMenuItem
              icon={Edit}
              onSelect={() => {
                setRenamingId(chat.id);
              }}
            >
              {t`Rename`}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              danger
              icon={Trash}
              onSelect={() => {
                onDeleting(true);
              }}
            >
              {t`Delete`}
            </DropdownMenuItem>
          </DropdownMenuPanel>
        </DropdownMenu>
      )}
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
