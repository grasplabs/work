import type { ChatSummary } from "@grasp-os/shared/chat";
import { chatTitleSchema } from "@grasp-os/shared/chat";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
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
import { Input } from "@grasp-os/ui/components/input";
import { toast } from "@grasp-os/ui/components/toast";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  FileTextIcon,
  PencilIcon,
  PrinterIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { useCopy } from "../copy.ts";
import { ErrorText } from "../error-text.tsx";
import { exportAs } from "../export/export-file.tsx";
import type { ExportFormat } from "../export/export-file.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { chatMarkdown } from "./chat-markdown.ts";
import { useFollowedChat } from "./chat-watch.ts";
import { DeleteChatDialog } from "./delete-chat-dialog.tsx";
import type { SourceName } from "./sources.tsx";

// Everything that can be done with the open chat, behind three dots beside
// "New chat" (grasplabs/prototype `components/chat/chat-more.tsx`): copy
// it as Markdown, download it, rename it, and delete it. Its row in the list of chats does the same, but
// here it is where the chat is read, and nothing lies over the messages.

/** Characters a file name can't hold on some system, and runs of space. */
const unsafeInFileName = /[\s"*/:<>?\\|]+/gu;

/** The name a chat downloads under: its title, made safe for a file. */
const fileNameOf = (title: string): string =>
  title
    .replaceAll(unsafeInFileName, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 80) || "grasp-chat";

/** Renames the chat, in a dialog of its own: Save keeps the name typed. */
const RenameDialog = ({
  chat,
  open,
  onOpenChange,
}: {
  chat: ChatSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [name, setName] = useState(chat.title);
  const parsed = chatTitleSchema.safeParse(name);
  const save = async (): Promise<void> => {
    if (!parsed.success) {
      return;
    }
    if (parsed.data === chat.title) {
      onOpenChange(false);
      return;
    }
    const renamed = await run(async (session) => {
      await session.chats.rename(chat.id, parsed.data);
      return true;
    });
    if (renamed === true) {
      onOpenChange(false);
      await router.invalidate();
    }
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-sm">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>Rename chat</Trans>
            </DialogTitle>
          </DialogHeader>
          <Input
            aria-label={t`Chat name`}
            // It opens to be typed in.
            autoFocus
            maxLength={200}
            onChange={(event) => {
              setName(event.target.value);
            }}
            onFocus={(event) => {
              event.currentTarget.select();
            }}
            value={name}
          />
          <ErrorText>{failure}</ErrorText>
          <DialogFooter showCloseButton>
            <Button disabled={busy || !parsed.success} type="submit">
              <Trans>Save</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/**
 * The open chat's menu in the page header. `sourceNames` name where its
 * answers came from in what it copies and downloads.
 */
export const ChatMore = ({
  chat,
  sourceNames,
}: {
  chat: ChatSummary;
  sourceNames: ReadonlyMap<string, SourceName>;
}) => {
  const { i18n, t } = useLingui();
  // The same watch the thread reads, so what is copied is what is shown.
  const { view } = useFollowedChat(chat.id);
  const { copied, copy } = useCopy();
  // Which chat a dialog was opened for: one opened for another chat, left
  // by Back or a link while it was open, is closed, never acting on this one.
  const [renamingId, setRenamingId] = useState<string>();
  const [deletingId, setDeletingId] = useState<string>();
  const renaming = renamingId === chat.id;
  const deleting = deletingId === chat.id;
  const onRenaming = (open: boolean): void => {
    setRenamingId(open ? chat.id : undefined);
  };
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
      toast.add({
        type: "error",
        title: t`The export didn't work. Try again.`,
      });
    }
  };
  return (
    <>
      <DropdownMenu>
        {/* A quiet icon, named when pointed at, as the header's others. */}
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                aria-label={t`More for this chat`}
                render={<Button size="icon-sm" variant="ghost" />}
              />
            }
          >
            <EllipsisIcon />
          </TooltipTrigger>
          <TooltipContent>
            <Trans>More for this chat</Trans>
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-60">
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
          <DropdownMenuItem
            onClick={() => {
              onRenaming(true);
            }}
          >
            <PencilIcon />
            <Trans>Rename</Trans>
          </DropdownMenuItem>
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
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Each mounts when it opens, so it starts from the chat as it is now. */}
      {renaming ? (
        <RenameDialog chat={chat} onOpenChange={onRenaming} open={renaming} />
      ) : null}
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
