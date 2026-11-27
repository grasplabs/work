import type { ChatSummary } from "@grasp-os/shared/chat";
import { chatTitleMaxLength, chatTitleSchema } from "@grasp-os/shared/chat";
import { DropdownMenuMore } from "@grasp-os/ui/components/dropdown-menu";
import type { DropdownMenuMoreItem } from "@grasp-os/ui/components/dropdown-menu";
import { toast } from "@grasp-os/ui/components/toast";
import {
  CopyIcon,
  FileDocIcon,
  FilePdfIcon,
  PencilIcon,
  TrashIcon,
} from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { copyText } from "../copy.ts";
import { exportAs } from "../export/export-file.tsx";
import type { ExportFormat } from "../export/export-file.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { chatMarkdown } from "./chat-markdown.ts";
import { useFollowedChat } from "./chat-watch.ts";
import { DeleteChatDialog } from "./delete-chat-dialog.tsx";
import type { SourceName } from "./sources.tsx";

// The open chat at the head of its panel (chat-panel.tsx): its name,
// renamed where it stands (the panel's title: a press, F2 or Enter), and
// its menu: copy it as Markdown, download it as Markdown or PDF, and
// delete it, as #2503 has it. Its row in the list of chats does the same,
// but here it is where the chat is read, and nothing lies over the
// messages.

/** Characters a file name can't hold on some system, and runs of space. */
const unsafeInFileName = /[\s"*/:<>?\\|]+/gu;

/** The name a chat downloads under: its title, made safe for a file. */
const fileNameOf = (title: string): string =>
  title
    .replaceAll(unsafeInFileName, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 80) || "grasp-chat";

/** A chat's rename where its name stands: the change, the most a name holds, and what is said when it fails. */
export interface ChatRename {
  /** Renames it to `name`, trimmed; rejects where core can't, so the rename stays open. */
  onRename: (name: string) => Promise<void>;
  maxLength: number;
  errorText: string;
}

/**
 * Renames chat `chatId` to a new name, trimmed, and reads the page again;
 * `onRenamed` shows the new name at once, for the chat it was given to.
 * Where core can't, the rename fails with `errorText`, which the field
 * says under the words typed (InlineEdit).
 */
export const useRenameChat = (
  chatId: string,
  onRenamed?: (renamed: string, title: string) => void
): ChatRename => {
  const { t } = useLingui();
  const router = useRouter();
  const { run } = useCoreAction();
  const errorText = t`The chat couldn't be renamed. Try again.`;
  const onRename = async (name: string): Promise<void> => {
    const parsed = chatTitleSchema.safeParse(name);
    const renamed =
      parsed.success &&
      (await run(async (session) => {
        await session.chats.rename(chatId, parsed.data);
        return true;
      }));
    if (renamed !== true || !parsed.success) {
      throw new Error(errorText);
    }
    onRenamed?.(chatId, parsed.data);
    await router.invalidate();
  };
  return { onRename, maxLength: chatTitleMaxLength, errorText };
};

/**
 * The chat's menu, as items: copy it as Markdown, download it as Markdown or
 * PDF, rename it (where `onRename` opens the rename) and delete it, with
 * the delete's confirming dialog to stand beside whatever shows the items.
 * The docked chat's head puts them in its own "…" (chat-panel.tsx); the
 * chat's page in a menu of its own (`ChatMoreMenu`).
 */
export const useChatMenu = ({
  chat,
  sourceNames,
  onRename,
}: {
  chat: ChatSummary;
  sourceNames: ReadonlyMap<string, SourceName>;
  /** Opens the rename where the chat's name stands, where it can be opened from here. */
  onRename?: () => void;
}): { actions: DropdownMenuMoreItem[]; dialog: ReactNode } => {
  const { i18n, t } = useLingui();
  // The same watch the thread reads, so what is copied is what is shown.
  const { view } = useFollowedChat(chat.id);
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
  const actions: DropdownMenuMoreItem[] = [
    {
      label: t`Copy as Markdown`,
      icon: CopyIcon,
      disabled: !ready,
      // The menu closes as it is chosen: a short notice says it is copied.
      onSelect: () => {
        void (async () => {
          if (await copyText(markdown())) {
            toast.success(t`Copied`);
          } else {
            toast.error(t`Copying didn't work`);
          }
        })();
      },
    },
    {
      label: t`Download as Markdown`,
      icon: FileDocIcon,
      disabled: !ready,
      onSelect: () => {
        void download("md");
      },
    },
    {
      label: t`Download as PDF`,
      icon: FilePdfIcon,
      disabled: !ready,
      onSelect: () => {
        void download("pdf");
      },
    },
    ...(onRename === undefined
      ? []
      : [{ label: t`Rename`, icon: PencilIcon, onSelect: onRename }]),
    {
      label: t`Delete`,
      icon: TrashIcon,
      variant: "destructive" as const,
      onSelect: () => {
        onDeleting(true);
      },
    },
  ];
  // It mounts when it opens, so it starts from the chat as it is now.
  const dialog = deleting ? (
    <DeleteChatDialog
      active
      chat={chat}
      onOpenChange={onDeleting}
      open={deleting}
    />
  ) : null;
  return { actions, dialog };
};

/** The chat's menu on its own "…" button, for the chat's page. */
export const ChatMoreMenu = (props: {
  chat: ChatSummary;
  sourceNames: ReadonlyMap<string, SourceName>;
  onRename?: () => void;
}) => {
  const { t } = useLingui();
  const { actions, dialog } = useChatMenu(props);
  return (
    <>
      <DropdownMenuMore aria-label={t`More for this chat`} items={actions} />
      {dialog}
    </>
  );
};
